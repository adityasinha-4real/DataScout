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

/**
 * Comma-separated list of exact origins. A wildcard is refused outright: the
 * API sends credentials, and browsers reject `*` with credentials anyway, so
 * accepting it would only defer the failure to the first cross-origin call.
 *
 * Blank means no cross-origin access at all, which is the production default:
 * the frontend reaches the API through a same-origin /api rewrite, so no
 * browser needs CORS. When set in production, every origin must be https.
 */
function origins(name, fallback, requireHttps) {
  const raw = optional(name, fallback);
  if (raw === '') return [];
  const list = raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin !== '');
  if (list.length === 0 || list.includes('*')) {
    throw new ConfigError(
      `Environment variable ${name} must list exact origins, not "*": ` +
        'the API sends credentials, which browsers never allow with a wildcard.',
    );
  }
  const insecure = requireHttps && list.find((o) => !o.startsWith('https://'));
  if (insecure) {
    throw new ConfigError(
      `Environment variable ${name} must list https origins in production, got "${insecure}".`,
    );
  }
  return list;
}

/** Like integer(), but 0 is allowed: used where 0 means "off". */
function nonNegativeInteger(name, fallback) {
  const raw = optional(name, String(fallback));
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(
      `Environment variable ${name} must be a non-negative integer, got "${raw}".`,
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
      jwtExpiresIn: integer('JWT_EXPIRES_IN', 900),
      corsOrigins: origins(
        'CORS_ORIGIN',
        nodeEnv === 'production' ? '' : 'http://localhost:5173',
        nodeEnv === 'production',
      ),
      maxUploadBytes: integer('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
      authRateLimitPerMin: integer('AUTH_RATE_LIMIT_PER_MIN', 10),
      // Reverse-proxy hops to trust for the client IP. 0 (default) means the
      // socket address is the client and X-Forwarded-For is ignored.
      trustProxy: nonNegativeInteger('TRUST_PROXY', 0),
      // Optional on purpose: without a key /ask answers 503 and every other
      // route keeps working, so the app is useful with no model configured.
      anthropicApiKey: optional('ANTHROPIC_API_KEY', ''),
      llmModel: optional('LLM_MODEL', 'claude-sonnet-5'),
    };
  } finally {
    process.env = previous;
  }
}

export { ConfigError };
