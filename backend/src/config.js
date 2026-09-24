/**
 * Single place where process.env is read. Everything else imports from here,
 * so the env contract in .env.example has exactly one surface to stay in sync
 * with. Validation happens at import time so a misconfigured server dies at
 * boot with a readable message instead of failing on the first request.
 */

class ConfigError extends Error {}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(
      `Missing required environment variable ${name}. ` +
        'Copy .env.example to .env and fill it in.',
    );
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function integer(name, fallback) {
  const raw = optional(name, String(fallback));
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      `Environment variable ${name} must be a positive integer, got "${raw}".`,
    );
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const previous = process.env;
  process.env = env;
  try {
    const nodeEnv = optional('NODE_ENV', 'development');
    if (!['development', 'test', 'production'].includes(nodeEnv)) {
      throw new ConfigError(
        `Environment variable NODE_ENV must be development, test or production, got "${nodeEnv}".`,
      );
    }

    const jwtSecret = required('JWT_SECRET');
    if (jwtSecret.length < 32) {
      throw new ConfigError(
        'Environment variable JWT_SECRET must be at least 32 characters long.',
      );
    }

    return {
      nodeEnv,
      isProduction: nodeEnv === 'production',
      port: integer('PORT', 4000),
      databaseUrl: optional('DATABASE_URL', './data/datascout.db'),
      jwtSecret,
      jwtExpiresIn: integer('JWT_EXPIRES_IN', 3600),
      corsOrigin: optional('CORS_ORIGIN', 'http://localhost:5173'),
      maxUploadBytes: integer('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
    };
  } finally {
    process.env = previous;
  }
}

export { ConfigError };
