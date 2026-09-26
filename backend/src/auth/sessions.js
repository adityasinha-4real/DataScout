import { randomUUID } from 'node:crypto';

import { unauthorized } from '../errors.js';
import { signToken, verifyToken } from './jwt.js';
import { readSessionCookie, setSessionCookie } from './cookie.js';

/**
 * Everything about a signed-in session: issuing tokens, reading them back,
 * refusing revoked ones, and sliding a browser session forward while it is in
 * use. Built once per app with that app's clock, so tests can move time
 * instead of waiting for it.
 */
export function createSessions(config, db, now = Date.now) {
  const secret = config.jwtSecret;
  const ttl = config.jwtExpiresIn;

  /**
   * The token from an `Authorization: Bearer` header if one is sent,
   * otherwise from the session cookie. A header that is present always wins,
   * so a client that sends one gets exactly its pre-cookie behaviour.
   */
  function credentialFrom(req) {
    const header = req.get('authorization');
    if (header !== undefined) {
      const [scheme, token] = header.split(' ');
      const valid = scheme?.toLowerCase() === 'bearer' && token;
      return valid ? { token, source: 'bearer' } : null;
    }
    const token = readSessionCookie(req.get('cookie'));
    return token ? { token, source: 'cookie' } : null;
  }

  const nowSeconds = () => Math.floor(now() / 1000);

  /**
   * A fresh token for this user at their current token_version. `sid` names
   * the session: a new sign-in starts one, and sliding re-issue keeps it, so
   * signing out one session catches every token that session ever held.
   */
  function sign(user, sid) {
    return signToken(
      { sub: user.id, ver: user.token_version, sid },
      secret,
      ttl,
      now(),
    );
  }

  /** Sign, set the HttpOnly session cookie, and return the token. */
  function issue(res, user, sid = randomUUID()) {
    const token = sign(user, sid);
    setSessionCookie(res, token, config);
    return token;
  }

  const revokedOf = (user) => JSON.parse(user.revoked_sessions);

  /**
   * The user and payload a token stands for, or null. Besides signature and
   * expiry:
   * - `ver` must equal the user's token_version (logout-all bumps it);
   * - `sid` must not be in the user's revoked_sessions (logout adds it).
   * A token missing either claim never matches.
   */
  function resolve(token) {
    const payload = verifyToken(token, secret, now());
    if (!payload?.sub || !Number.isInteger(payload.ver)) return null;
    if (typeof payload.sid !== 'string' || payload.sid === '') return null;

    const user = db
      .prepare(
        'SELECT id, email, created_at, token_version, revoked_sessions FROM users WHERE id = ?',
      )
      .get(payload.sub);
    if (!user || user.token_version !== payload.ver) return null;
    if (revokedOf(user).some((entry) => entry.sid === payload.sid)) return null;
    return { user, payload };
  }

  /** True once at least half of the token's lifetime has elapsed. */
  function pastHalfLife(payload) {
    const elapsed = Math.floor(now() / 1000) - payload.iat;
    return elapsed * 2 >= payload.exp - payload.iat;
  }

  /**
   * Resolves the bearer token or session cookie to a real user row. Missing,
   * malformed, expired, revoked, or orphaned tokens all fail the same way, so
   * the response never tells an attacker which.
   *
   * Sliding session: a request authenticated by the *cookie* whose token is
   * past half its lifetime gets the cookie re-set with a fresh token, so an
   * active browser stays signed in while an idle one lapses after the TTL.
   * Bearer clients are left alone: they never read cookies, and setting one
   * would quietly create a browser session for an API client.
   */
  function requireAuth(req, res, next) {
    const credential = credentialFrom(req);
    if (!credential) {
      return next(unauthorized('Missing bearer token or session cookie.'));
    }

    const session = resolve(credential.token);
    if (!session) {
      return next(unauthorized('Invalid or expired token.'));
    }

    const { user, payload } = session;
    if (credential.source === 'cookie' && pastHalfLife(payload)) {
      issue(res, user, payload.sid);
    }

    req.user = { id: user.id, email: user.email, createdAt: user.created_at };
    return next();
  }

  /** The session behind this request if it is currently valid, else null. */
  function current(req) {
    const credential = credentialFrom(req);
    return credential ? resolve(credential.token) : null;
  }

  /**
   * Sign out one session. Its sid is recorded until no token of it can still
   * be alive: every token it holds was issued no later than now, so all have
   * expired by now + TTL, and once revoked it can never be re-issued. Entries
   * past that point are pruned on the same write, so the list stays as small
   * as the number of sessions signed out in the last TTL.
   */
  function revokeSession({ user, payload }) {
    const at = nowSeconds();
    const kept = revokedOf(user).filter((entry) => entry.until > at);
    kept.push({ sid: payload.sid, until: at + ttl });
    db.prepare('UPDATE users SET revoked_sessions = ? WHERE id = ?').run(
      JSON.stringify(kept),
      user.id,
    );
  }

  /**
   * Sign out everywhere: bumping token_version retires every token of every
   * session at once, which also makes the per-session list redundant.
   */
  function revokeAll({ user }) {
    db.prepare(
      `UPDATE users SET token_version = token_version + 1, revoked_sessions = '[]'
       WHERE id = ? AND token_version = ?`,
    ).run(user.id, user.token_version);
  }

  return { issue, requireAuth, current, revokeSession, revokeAll };
}
