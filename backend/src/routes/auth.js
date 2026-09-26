import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { badRequest, conflict, unauthorized } from '../errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/jwt.js';
import {
  credentialFrom,
  requireAuth,
  userForToken,
} from '../auth/middleware.js';
import { clearSessionCookie, setSessionCookie } from '../auth/cookie.js';

const credentials = z.object({
  email: z.string().trim().min(3).max(254).email(),
  password: z.string().min(8).max(200),
});

function validate(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
    }));
    throw badRequest('VALIDATION_ERROR', 'The request body is invalid.', details);
  }
  return result.data;
}

const publicUser = (row) => ({
  id: row.id,
  email: row.email,
  createdAt: row.created_at ?? row.createdAt,
});

/**
 * `limiter` guards register and login only: they are the endpoints where a
 * guess costs an attacker nothing but a request. Both draw on one per-IP
 * budget, so alternating between them buys no extra attempts.
 */
export function authRouter(config, db, limiter = (req, res, next) => next()) {
  const router = Router();

  router.post('/auth/register', limiter, (req, res) => {
    const { email, password } = validate(credentials, req.body);
    const normalized = email.toLowerCase();

    const existing = db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get(normalized);
    if (existing) {
      throw conflict('EMAIL_TAKEN', 'An account with that email already exists.');
    }

    const user = {
      id: randomUUID(),
      email: normalized,
      created_at: new Date().toISOString(),
    };
    db.prepare(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    ).run(user.id, user.email, hashPassword(password), user.created_at);

    // A new account starts at token_version 0 (the column default).
    const token = signToken({ sub: user.id, ver: 0 }, config.jwtSecret, config.jwtExpiresIn);
    setSessionCookie(res, token, config);
    // The token stays in the body too: existing API clients rely on it (C7).
    res.status(201).json({
      user: publicUser(user),
      token,
      expiresIn: config.jwtExpiresIn,
    });
  });

  router.post('/auth/login', limiter, (req, res) => {
    const { email, password } = validate(credentials, req.body);
    const row = db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email.toLowerCase());

    // Same response whether the email is unknown or the password is wrong,
    // so the endpoint cannot be used to enumerate accounts.
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw unauthorized('Incorrect email or password.');
    }

    const token = signToken(
      { sub: row.id, ver: row.token_version },
      config.jwtSecret,
      config.jwtExpiresIn,
    );
    setSessionCookie(res, token, config);
    res.json({
      user: publicUser(row),
      token,
      expiresIn: config.jwtExpiresIn,
    });
  });

  /**
   * Clears the cookie and, when the request carries a currently valid token,
   * bumps the user's token_version so every token issued before now — on
   * this device or any other, copied or not — is refused from here on.
   *
   * Only a *valid* token can do that: a stale or revoked one just gets the
   * cookie cleared, so replaying an old token cannot keep logging the real
   * user out. Signing out when already signed out is not an error.
   */
  router.post('/auth/logout', (req, res) => {
    const token = credentialFrom(req);
    const user = token ? userForToken(token, config, db) : null;
    if (user) {
      db.prepare(
        'UPDATE users SET token_version = token_version + 1 WHERE id = ? AND token_version = ?',
      ).run(user.id, user.token_version);
    }
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth(config, db), (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}

export { validate };
