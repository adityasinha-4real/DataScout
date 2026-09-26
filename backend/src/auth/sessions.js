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

  /** A fresh token for this user, at their current token_version. */
  function sign(user) {
    return signToken({ sub: user.id, ver: user.token_version }, secret, ttl, now());
  }

  /** Sign, set the HttpOnly session cookie, and return the token. */
  function issue(res, user) {
    const token = sign(user);
    setSessionCookie(res, token, config);
    return token;
  }

  /**
   * The user and payload a token stands for, or null. Besides signature and
   * expiry, `ver` must equal the user's current token_version: logout bumps
   * it, retiring every earlier token, copies included.
   */
  function resolve(token) {
    const payload = verifyToken(token, secret, now());
    if (!payload?.sub || !Number.isInteger(payload.ver)) return null;

    const user = db
      .prepare('SELECT id, email, created_at, token_version FROM users WHERE id = ?')
      .get(payload.sub);
    if (!user || user.token_version !== payload.ver) return null;
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
      issue(res, user);
    }

    req.user = { id: user.id, email: user.email, createdAt: user.created_at };
    return next();
  }

  /** The session behind this request if it is currently valid, else null. */
  function current(req) {
    const credential = credentialFrom(req);
    return credential ? resolve(credential.token) : null;
  }

  return { issue, requireAuth, current };
}
