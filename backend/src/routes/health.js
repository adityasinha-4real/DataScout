import { Router } from 'express';
import { isConnected } from '../db/index.js';

export function healthRouter(db) {
  const router = Router();

  router.get('/health', (req, res) => {
    const connected = isConnected(db);
    res.status(connected ? 200 : 503).json({
      status: connected ? 'ok' : 'degraded',
      db: connected ? 'connected' : 'disconnected',
      uptime: Math.round(process.uptime()),
    });
  });

  return router;
}
