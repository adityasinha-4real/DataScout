import { Router } from 'express';

/**
 * GET /api/_debug/ip — the instrument for measuring TRUST_PROXY on a real
 * deployment. Mounted only when DEBUG_IP_ENDPOINT=1 (see app.js); it reveals
 * the addresses of the proxies in front of the API, so it must not stay on.
 *
 * `chain` is the list Express walks for `trust proxy`: the socket peer first,
 * then X-Forwarded-For from right (nearest proxy) to left. With TRUST_PROXY=N,
 * req.ip is chain[N]. So the index at which the caller's own public address
 * appears *is* the hop count to configure.
 */
export function debugRouter(config) {
  const router = Router();

  router.get('/_debug/ip', (req, res) => {
    const forwarded = req.get('x-forwarded-for') ?? null;
    const listed = (forwarded ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const remoteAddress = req.socket.remoteAddress ?? null;

    res.set('Cache-Control', 'no-store').json({
      ip: req.ip,
      ips: req.ips,
      xForwardedFor: forwarded,
      remoteAddress,
      chain: [remoteAddress, ...listed.reverse()],
      trustProxy: config.trustProxy,
    });
  });

  return router;
}
