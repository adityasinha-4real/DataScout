import { createApp } from './app.js';
import { loadConfig, ConfigError } from './config.js';
import { openDatabase } from './db/index.js';

/** Boot entry point. Misconfiguration exits 1 with a readable reason. */
function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
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
