import express from 'express';
import cors from 'cors';

import { AppError, errorHandler, notFoundHandler } from './errors.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { datasetsRouter } from './routes/datasets.js';

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

export function createApp(config, db) {
  const app = express();
  app.disable('x-powered-by');

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '1mb' }));
  app.use(
    express.text({
      type: ['text/csv', 'text/plain', 'application/csv'],
      limit: config.maxUploadBytes,
    }),
  );

  app.use('/api', healthRouter(db));
  app.use('/api', authRouter(config, db));
  app.use('/api', datasetsRouter(config, db));

  app.use(notFoundHandler());
  app.use(normalizeBodyErrors());
  app.use(errorHandler(config.isProduction));

  return app;
}
