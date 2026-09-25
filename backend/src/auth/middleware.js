import { unauthorized } from '../errors.js';
import { verifyToken } from './jwt.js';
import { readSessionCookie } from './cookie.js';

/**
 * The token from an `Authorization: Bearer` header if one is sent, otherwise
 * from the session cookie. A header that is present always wins, so a client
 * that sends one gets exactly the behaviour it had before the cookie existed.
 */
function credentialFrom(req) {
  const header = req.get('authorization');
  if (header !== undefined) {
    const [scheme, token] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && token ? token : null;
  }
  return readSessionCookie(req.get('cookie'));
}

/**
 * Resolves the bearer token or session cookie to a real user row. A token
 * that is missing, malformed, expired, or points at a deleted user all fail
 * the same way, so the response never tells an attacker which it was.
 */
export function requireAuth(config, db) {
  return (req, res, next) => {
    const token = credentialFrom(req);
    if (!token) {
      return next(unauthorized('Missing bearer token or session cookie.'));
    }

    const payload = verifyToken(token, config.jwtSecret);
    if (!payload?.sub) {
      return next(unauthorized('Invalid or expired token.'));
    }

    const user = db
      .prepare('SELECT id, email, created_at FROM users WHERE id = ?')
      .get(payload.sub);
    if (!user) {
      return next(unauthorized('Invalid or expired token.'));
    }

    req.user = { id: user.id, email: user.email, createdAt: user.created_at };
    return next();
  };
}
