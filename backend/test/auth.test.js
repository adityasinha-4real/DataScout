import test from 'node:test';
import assert from 'node:assert/strict';

import { api, registerUser, startTestServer } from './helpers.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { signToken, verifyToken } from '../src/auth/jwt.js';

const { baseUrl, db, config } = await startTestServer();

test('register returns 201 with a token and a public user object', async () => {
  const { status, body } = await api(baseUrl, '/api/auth/register', {
    method: 'POST',
    json: { email: 'New.User@Example.com', password: 'correct-horse-9' },
  });

  assert.equal(status, 201);
  assert.equal(body.user.email, 'new.user@example.com');
  assert.ok(body.token);
  assert.equal(body.user.password, undefined);
  assert.equal(body.user.passwordHash, undefined);
});

test('the stored password is hashed, not the plaintext', () => {
  const row = db
    .prepare('SELECT password_hash FROM users WHERE email = ?')
    .get('new.user@example.com');
  assert.ok(row);
  assert.ok(!row.password_hash.includes('correct-horse-9'));
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(verifyPassword('correct-horse-9', row.password_hash));
});

test('a duplicate email returns 409 EMAIL_TAKEN', async () => {
  const { status, body } = await api(baseUrl, '/api/auth/register', {
    method: 'POST',
    json: { email: 'new.user@example.com', password: 'another-password' },
  });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'EMAIL_TAKEN');
});

test('login succeeds with the right password and returns a usable token', async () => {
  const { status, body } = await api(baseUrl, '/api/auth/login', {
    method: 'POST',
    json: { email: 'new.user@example.com', password: 'correct-horse-9' },
  });
  assert.equal(status, 200);

  const me = await api(baseUrl, '/api/auth/me', { token: body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'new.user@example.com');
});

test('login with a wrong password and an unknown email look identical', async () => {
  const wrongPassword = await api(baseUrl, '/api/auth/login', {
    method: 'POST',
    json: { email: 'new.user@example.com', password: 'not-the-password' },
  });
  const unknownEmail = await api(baseUrl, '/api/auth/login', {
    method: 'POST',
    json: { email: 'nobody@example.com', password: 'not-the-password' },
  });

  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(wrongPassword.body, unknownEmail.body);
  assert.equal(wrongPassword.body.error.code, 'UNAUTHORIZED');
});

test('/api/auth/me rejects missing, malformed and expired tokens with 401', async () => {
  const cases = {
    missing: {},
    notBearer: { headers: { authorization: 'Basic abc' } },
    garbage: { token: 'not-a-jwt' },
    tampered: { token: `${signToken({ sub: 'x' }, config.jwtSecret, 60)}tamper` },
    wrongSecret: { token: signToken({ sub: 'x' }, 'a'.repeat(40), 60) },
    expired: { token: signToken({ sub: 'x' }, config.jwtSecret, -10) },
  };

  for (const [label, options] of Object.entries(cases)) {
    const { status, body } = await api(baseUrl, '/api/auth/me', options);
    assert.equal(status, 401, `${label} should be 401, got ${status}`);
    assert.equal(body.error.code, 'UNAUTHORIZED');
  }
});

test('a valid token for a user that no longer exists is rejected', async () => {
  const user = await registerUser(baseUrl);
  db.prepare('DELETE FROM users WHERE email = ?').run(user.email);

  const { status } = await api(baseUrl, '/api/auth/me', { token: user.token });
  assert.equal(status, 401);
});

test('register validates email shape and password length with 400', async () => {
  for (const json of [
    { email: 'not-an-email', password: 'correct-horse-9' },
    { email: 'fine@example.com', password: 'short' },
    { email: 'fine@example.com' },
    {},
  ]) {
    const { status, body } = await api(baseUrl, '/api/auth/register', {
      method: 'POST',
      json,
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(body.error.details));
  }
});

test('hashPassword produces a different digest every time', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a, b);
  assert.ok(verifyPassword('same-password', a));
  assert.ok(verifyPassword('same-password', b));
  assert.ok(!verifyPassword('other-password', a));
});

test('verifyPassword rejects malformed stored hashes instead of throwing', () => {
  for (const stored of ['', 'plaintext', 'scrypt$bad', null, 'scrypt$a$b$c$d$e']) {
    assert.equal(verifyPassword('x', stored), false);
  }
});

test('verifyToken rejects tokens that are not three signed segments', () => {
  assert.equal(verifyToken('a.b', 'secret'), null);
  assert.equal(verifyToken(null, 'secret'), null);
  assert.equal(verifyToken('a.b.c', 'secret'), null);
});

test('a token with no exp claim is rejected', async () => {
  const secret = 'x'.repeat(40);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url');
  const { createHmac } = await import('node:crypto');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  assert.equal(verifyToken(`${header}.${payload}.${signature}`, secret), null);
});
