import { AppError } from '../errors.js';

/**
 * A rate-limit store: where hit timestamps live. The limiter only ever calls
 * one method, and it is async, so a networked store can implement it:
 *
 *   hit(key, nowMs, windowMs, limit) -> Promise<{ allowed: boolean, oldestMs: number }>
 *
 * Atomically: forget the key's hits older than `nowMs - windowMs`; if fewer
 * than `limit` remain, record `nowMs` and allow; otherwise record nothing and
 * deny. `oldestMs` is the oldest hit still counted (the one whose expiry
 * frees the next slot). It must be a single atomic operation so concurrent
 * requests across processes cannot both take the last slot; for Redis that
 * is one Lua script over a sorted set (ZREMRANGEBYSCORE, ZCARD, ZADD, ZRANGE,
 * PEXPIRE).
 *
 * @typedef {{ hit(key: string, nowMs: number, windowMs: number, limit: number):
 *   Promise<{ allowed: boolean, oldestMs: number }> }} RateLimitStore
 */

/**
 * The default store: one in-process Map. Counters vanish on restart and are
 * not shared between processes, so N replicas would each allow `limit` — a
 * shared store is required before running more than one API instance.
 * Clients that go quiet are swept once per window, so memory stays bounded by
 * the clients seen in the last window, each holding at most `limit` entries.
 */
export function createMemoryStore() {
  const hits = new Map();
  let nextSweep = 0;

  function sweep(nowMs, windowMs) {
    if (nowMs < nextSweep) return;
    nextSweep = nowMs + windowMs;
    for (const [key, log] of hits) {
      if (log[log.length - 1] <= nowMs - windowMs) hits.delete(key);
    }
  }

  return {
    async hit(key, nowMs, windowMs, limit) {
      sweep(nowMs, windowMs);
      const log = (hits.get(key) ?? []).filter((t) => t > nowMs - windowMs);
      const allowed = log.length < limit;
      if (allowed) log.push(nowMs);
      hits.set(key, log);
      return { allowed, oldestMs: log[0] };
    },
    /** How many clients are tracked; lets tests observe the sweep. */
    size: () => hits.size,
  };
}

/**
 * A sliding-window limiter: at most `limit` requests per key in any
 * `windowMs` span, counted exactly from a log of timestamps rather than fixed
 * buckets, so a burst straddling a bucket edge cannot get twice the budget.
 *
 * The app factory builds one per app, so two apps — two test files, say —
 * never share counters. `now` and `store` are injectable: tests move time
 * instead of sleeping, and a shared store can replace the in-memory one.
 * A store that fails rejects the request (500) rather than waving it through.
 */
export function createRateLimiter({
  limit,
  windowMs = 60_000,
  now = Date.now,
  store = createMemoryStore(),
}) {
  return async function rateLimit(req, res, next) {
    const at = now();
    const key = req.ip ?? 'unknown';
    const { allowed, oldestMs } = await store.hit(key, at, windowMs, limit);
    if (allowed) return next();

    // Seconds until the oldest counted hit leaves the window, rounded up so
    // a client that waits exactly this long is always let through.
    const retryAfter = Math.max(1, Math.ceil((oldestMs + windowMs - at) / 1000));
    res.set('Retry-After', String(retryAfter));
    return next(
      new AppError(
        429,
        'RATE_LIMITED',
        `Too many sign-in attempts. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
      ),
    );
  };
}
