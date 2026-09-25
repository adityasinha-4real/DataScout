import { AppError } from '../errors.js';

/**
 * A sliding-window limiter: at most `limit` requests per key in any
 * `windowMs` span, counted exactly from a log of timestamps rather than from
 * fixed buckets, so a burst straddling a bucket edge cannot get twice the
 * budget. Each key's log holds at most `limit` entries.
 *
 * State lives in the closure, and the app factory builds one per app, so two
 * apps — two test files, say — never share a counter. `now` is injectable so
 * tests can move time instead of sleeping.
 */
export function createRateLimiter({ limit, windowMs = 60_000, now = Date.now }) {
  const hits = new Map();
  let nextSweep = 0;

  /** Drop keys whose newest hit has left the window, so memory stays bounded. */
  function sweep(at) {
    if (at < nextSweep) return;
    nextSweep = at + windowMs;
    for (const [key, log] of hits) {
      if (log[log.length - 1] <= at - windowMs) hits.delete(key);
    }
  }

  function rateLimit(req, res, next) {
    const at = now();
    sweep(at);

    const key = req.ip ?? 'unknown';
    const log = (hits.get(key) ?? []).filter((t) => t > at - windowMs);

    if (log.length >= limit) {
      hits.set(key, log);
      // Seconds until the oldest counted hit leaves the window, rounded up so
      // a client that waits exactly this long is always let through.
      const retryAfter = Math.max(1, Math.ceil((log[0] + windowMs - at) / 1000));
      res.set('Retry-After', String(retryAfter));
      return next(
        new AppError(
          429,
          'RATE_LIMITED',
          `Too many sign-in attempts. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
        ),
      );
    }

    log.push(at);
    hits.set(key, log);
    return next();
  }

  /** How many clients are being tracked; lets the sweep be observed. */
  rateLimit.trackedKeys = () => hits.size;
  return rateLimit;
}
