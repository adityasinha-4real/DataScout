import { unauthorized } from '../errors.js';
import { verifyToken } from './jwt.js';

/**
 * Resolves the bearer token to a real user row. A token that is missing,
 * malformed, expired, or points at a deleted user all fail the same way, so
 * the response never tells an attacker which of those it was.
 */
export function requireAuth(config, db) {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return next(unauthorized('Missing bearer token.'));
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
