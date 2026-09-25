import express from 'express';
import cors from 'cors';

import { AppError, errorHandler, notFoundHandler } from './errors.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { datasetsRouter } from './routes/datasets.js';
import { createProvider } from './llm/provider.js';
import { createRateLimiter } from './auth/rateLimit.js';

/**
 * Body-parser reports its own failures with a `type` field and no error code
 * of ours. Translate those into AppError so every response the client sees
 * still has the { error: { code, message } } shape.
 */
function normalizeBodyErrors() {
  return (err, req, res, next) => {
    if (err?.type === 'entity.too.large') {
      return next(
        new AppError(
          413,
          'PAYLOAD_TOO_LARGE',
          'That file is larger than the upload limit.',
        ),
      );
    }
    if (err?.type === 'entity.parse.failed') {
      return next(
        new AppError(400, 'INVALID_JSON', 'The request body is not valid JSON.'),
      );
    }
    return next(err);
  };
}

/**
 * Credentialed CORS against an explicit allowlist. An allowed browser origin
 * is echoed back; any other origin gets no Access-Control-Allow-Origin at all,
 * so the browser withholds the response. A request with no Origin header is
 * not from a browser page and has nothing to protect against, so it gets the
 * primary origin, as it did before the allowlist existed.
 */
function corsOrigin(allowed) {
  return (origin, callback) => {
    if (!origin) return callback(null, allowed[0]);
    return callback(null, allowed.includes(origin) ? origin : false);
  };
}

/**
 * `deps` exists so the model provider can be swapped for a double and the
 * rate limiter's clock can be moved in tests. Those are the only seams:
 * application behaviour never branches on NODE_ENV, and with `deps` omitted
 * the app builds exactly what production would.
 */
export function createApp(config, db, deps = {}) {
  const app = express();
  app.disable('x-powered-by');
  const llm = deps.llm === undefined ? createProvider(config) : deps.llm;
  // Behind a proxy every request arrives from the proxy's address, so without
  // this all clients would share one rate-limit budget. Trusting more hops
  // than really exist would let a client pick its own IP via X-Forwarded-For.
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);
  // Built here, per app, so no two apps (or test files) share counters.
  const authLimiter = createRateLimiter({
    limit: config.authRateLimitPerMin,
    windowMs: 60_000,
    now: deps.now ?? Date.now,
  });

  app.use(
    cors({
      origin: corsOrigin(config.corsOrigins),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(
    express.text({
      type: ['text/csv', 'text/plain', 'application/csv'],
      limit: config.maxUploadBytes,
    }),
  );

  app.use('/api', healthRouter(db));
  app.use('/api', authRouter(config, db, authLimiter));
  app.use('/api', datasetsRouter(config, db, llm));

  app.use(notFoundHandler());
  app.use(normalizeBodyErrors());
  app.use(errorHandler(config.isProduction));

  return app;
}
