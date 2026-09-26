import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { badRequest, conflict, unauthorized } from '../errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { clearSessionCookie } from '../auth/cookie.js';

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
export function authRouter(config, db, sessions, limiter) {
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
    const token = sessions.issue(res, { ...user, token_version: 0 });
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

    const token = sessions.issue(res, row);
    res.json({
      user: publicUser(row),
      token,
      expiresIn: config.jwtExpiresIn,
    });
  });

  /**
   * Both sign-outs clear the cookie and answer 204, signed in or not. Only a
   * *currently valid* token revokes anything: a stale or already-revoked one
   * just gets the cookie cleared, so replaying an old token can never log the
   * real user out.
   */
  const signOut = (revoke) => (req, res) => {
    const session = sessions.current(req);
    if (session) revoke(session);
    clearSessionCookie(res, config);
    res.status(204).end();
  };

  /** This session only: other devices stay signed in. */
  router.post('/auth/logout', signOut(sessions.revokeSession));

  /** Every session of this user, on every device, copies included. */
  router.post('/auth/logout-all', signOut(sessions.revokeAll));

  router.get('/auth/me', sessions.requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}

export { validate };
