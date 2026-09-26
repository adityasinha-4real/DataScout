import { createApp } from './app.js';
import { assertStartable, loadConfig, ConfigError } from './config.js';
import { openDatabase } from './db/index.js';

/** Boot entry point. Misconfiguration exits 1 with a readable reason. */
function main() {
  let config;
  try {
    config = loadConfig();
    assertStartable(config);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (config.debugIpEndpoint) {
    console.warn(
      'DEBUG_IP_ENDPOINT=1: GET /api/_debug/ip is mounted and shows proxy ' +
        'addresses to anyone. Remove the flag once TRUST_PROXY is measured.',
    );
  }

  const db = openDatabase(config.databaseUrl);
  const server = createApp(config, db).listen(config.port, () => {
    console.log(
      `DataScout API listening on http://localhost:${config.port} (${config.nodeEnv})`,
    );
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
