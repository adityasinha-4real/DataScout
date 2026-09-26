import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test, { describe } from 'node:test';

import { api, registerUser } from './helpers.js';
import { startServerWith } from './harness.js';
import { signToken, verifyToken } from '../src/auth/jwt.js';
import { SESSION_COOKIE } from '../src/auth/cookie.js';
import { applySchema } from '../src/db/index.js';

const PASSWORD = 'correct-horse-9';

const me = (baseUrl, headers) => api(baseUrl, '/api/auth/me', { headers });
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const cookie = (token) => ({ cookie: `${SESSION_COOKIE}=${token}` });

const login = async (baseUrl, email) => {
  const result = await api(baseUrl, '/api/auth/login', {
    method: 'POST',
    json: { email, password: PASSWORD },
  });
  assert.equal(result.status, 200);
  return result.body.token;
};

const logout = (baseUrl, headers = {}) =>
  api(baseUrl, '/api/auth/logout', { method: 'POST', headers });

const versionOf = (db, id) =>
  db.prepare('SELECT token_version FROM users WHERE id = ?').get(id).token_version;

describe('logout revokes earlier tokens', () => {
  test('a token copied before logout is 401 after it, as Bearer or as cookie', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const user = await registerUser(baseUrl, PASSWORD);
    const copied = user.token;

    assert.equal((await me(baseUrl, bearer(copied))).status, 200);
    assert.equal((await me(baseUrl, cookie(copied))).status, 200);

    // The browser signs out with its cookie; the attacker kept a copy.
    assert.equal((await logout(baseUrl, cookie(copied))).status, 204);

    const asBearer = await me(baseUrl, bearer(copied));
    assert.equal(asBearer.status, 401);
    assert.equal(asBearer.body.error.code, 'UNAUTHORIZED');
    assert.equal((await me(baseUrl, cookie(copied))).status, 401);
    const datasets = await api(baseUrl, '/api/datasets', { headers: bearer(copied) });
    assert.equal(datasets.status, 401, 'every protected route, not just /me');
  });

  test('a token issued by signing in again works; the old one stays dead', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const user = await registerUser(baseUrl, PASSWORD);
    await logout(baseUrl, bearer(user.token));

    const fresh = await login(baseUrl, user.email);
    assert.notEqual(fresh, user.token);
    assert.equal((await me(baseUrl, bearer(fresh))).status, 200);
    assert.equal((await me(baseUrl, cookie(fresh))).status, 200);
    assert.equal((await me(baseUrl, bearer(user.token))).status, 401);
  });

  test('logout ends every session of that user, not just the one it came from', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const user = await registerUser(baseUrl, PASSWORD);
    const laptop = await login(baseUrl, user.email);
    const phone = await login(baseUrl, user.email);

    await logout(baseUrl, bearer(laptop));

    for (const token of [user.token, laptop, phone]) {
      assert.equal((await me(baseUrl, bearer(token))).status, 401);
    }
  });

  test('other users are untouched', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const alice = await registerUser(baseUrl, PASSWORD);
    const bob = await registerUser(baseUrl, PASSWORD);

    await logout(baseUrl, bearer(alice.token));
    assert.equal((await me(baseUrl, bearer(bob.token))).status, 200);
  });

  test('a revoked token cannot log the user out again', async () => {
    const { baseUrl, db } = await startServerWith({ llm: null });
    const user = await registerUser(baseUrl, PASSWORD);
    const stolen = user.token;
    await logout(baseUrl, bearer(stolen));
    const fresh = await login(baseUrl, user.email);
    const version = versionOf(db, user.user.id);

    // Replaying the stolen, already-revoked token at /logout clears a cookie
    // but must not bump the version and kill the user's new session.
    assert.equal((await logout(baseUrl, bearer(stolen))).status, 204);
    assert.equal(versionOf(db, user.user.id), version);
    assert.equal((await me(baseUrl, bearer(fresh))).status, 200);
  });

  test('logout with no credentials, or garbage, is 204 and revokes nothing', async () => {
    const { baseUrl, db } = await startServerWith({ llm: null });
    const user = await registerUser(baseUrl, PASSWORD);

    assert.equal((await logout(baseUrl)).status, 204);
    assert.equal((await logout(baseUrl, bearer('not-a-token'))).status, 204);
    assert.equal((await logout(baseUrl, cookie('x.y.z'))).status, 204);
    assert.equal(versionOf(db, user.user.id), 0);
    assert.equal((await me(baseUrl, bearer(user.token))).status, 200);
  });

  test('tokens carry the version, and one with no or a wrong version is refused', async () => {
    const { baseUrl, config } = await startServerWith({ llm: null });
    const user = await registerUser(baseUrl, PASSWORD);
    assert.equal(verifyToken(user.token, config.jwtSecret).ver, 0);

    const sub = user.user.id;
    const secret = config.jwtSecret;
    const cases = {
      noVersion: signToken({ sub }, secret, 60),
      futureVersion: signToken({ sub, ver: 1 }, secret, 60),
      stringVersion: signToken({ sub, ver: '0' }, secret, 60),
    };
    for (const [name, token] of Object.entries(cases)) {
      assert.equal((await me(baseUrl, bearer(token))).status, 401, name);
    }
    // Correctly signed with the current version: accepted.
    assert.equal((await me(baseUrl, bearer(signToken({ sub, ver: 0 }, secret, 60)))).status, 200);

    await logout(baseUrl, bearer(user.token));
    const relogged = await login(baseUrl, user.email);
    assert.equal(verifyToken(relogged, secret).ver, 1);
  });
});

describe('schema and TTL', () => {
  test('an existing database gains token_version, with 0 for existing users', () => {
    const db = new DatabaseSync(':memory:');
    // The users table exactly as it was before token_version existed.
    db.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`);
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('u1', 'a@b.c', 'h', 'now');

    applySchema(db);
    applySchema(db); // idempotent: a second boot must not fail

    const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    assert.ok(columns.includes('token_version'));
    assert.equal(db.prepare('SELECT token_version FROM users').get().token_version, 0);
    db.close();
  });

  test('a configured 15-minute TTL is what tokens and the cookie get', async () => {
    const { baseUrl, config } = await startServerWith({ llm: null }, { JWT_EXPIRES_IN: '900' });
    const result = await api(baseUrl, '/api/auth/register', {
      method: 'POST',
      json: { email: `ttl.${Date.now()}@example.com`, password: PASSWORD },
    });
    assert.equal(result.body.expiresIn, 900);
    const payload = verifyToken(result.body.token, config.jwtSecret);
    assert.equal(payload.exp - payload.iat, 900);
    const setCookie = result.headers.getSetCookie().join('\n');
    assert.match(setCookie, /Max-Age=900/);
  });

  test('the production image and .env.example both set 15 minutes', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    const env = /^ENV\s+((?:.*\\\r?\n)*.*)$/m.exec(dockerfile)?.[1] ?? '';
    assert.match(env, /\bJWT_EXPIRES_IN=900\b/);

    const example = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
    assert.match(example, /^JWT_EXPIRES_IN=900\r?$/m);
  });
});
