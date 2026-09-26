import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test, { describe } from 'node:test';

import { api } from './helpers.js';
import { startServerWith } from './harness.js';
import { signToken, verifyToken } from '../src/auth/jwt.js';
import { SESSION_COOKIE } from '../src/auth/cookie.js';
import { applySchema } from '../src/db/index.js';

const PASSWORD = 'correct-horse-9';
const TTL = 900;

const bearer = (token) => ({ authorization: `Bearer ${token}` });
const cookie = (token) => ({ cookie: `${SESSION_COOKIE}=${token}` });
const me = (baseUrl, headers) => api(baseUrl, '/api/auth/me', { headers });
const post = (baseUrl, path, headers = {}) =>
  api(baseUrl, path, { method: 'POST', headers });
const logout = (baseUrl, headers) => post(baseUrl, '/api/auth/logout', headers);
const logoutAll = (baseUrl, headers) => post(baseUrl, '/api/auth/logout-all', headers);

function manualClock() {
  let now = 1_800_000_000_000;
  return { now: () => now, advance: (s) => (now += s * 1000) };
}

let counter = 0;

/** An app on a manual clock and one user, signed in on two devices. */
async function twoSessions() {
  const clock = manualClock();
  const server = await startServerWith({ llm: null, now: clock.now });
  counter += 1;
  const email = `rev${counter}.${Date.now()}@example.com`;
  const reg = await api(server.baseUrl, '/api/auth/register', {
    method: 'POST',
    json: { email, password: PASSWORD },
  });
  assert.equal(reg.status, 201);
  const login = async () => {
    const result = await api(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email, password: PASSWORD },
    });
    assert.equal(result.status, 200);
    return result.body.token;
  };
  return {
    ...server,
    clock,
    email,
    id: reg.body.user.id,
    login,
    a: reg.body.token,
    b: await login(),
  };
}

const row = (db, id) =>
  db.prepare('SELECT token_version, revoked_sessions FROM users WHERE id = ?').get(id);
const revokedSids = (db, id) => JSON.parse(row(db, id).revoked_sessions).map((e) => e.sid);
const sidOf = (token, secret) => verifyToken(token, secret, 1_800_000_000_000).sid;

describe('POST /api/auth/logout — this session only', () => {
  test('logout on session A leaves session B working', async () => {
    const { baseUrl, a, b } = await twoSessions();

    assert.equal((await logout(baseUrl, cookie(a))).status, 204);

    assert.equal((await me(baseUrl, bearer(a))).status, 401);
    assert.equal((await me(baseUrl, cookie(a))).status, 401);
    assert.equal((await me(baseUrl, bearer(b))).status, 200);
    assert.equal((await me(baseUrl, cookie(b))).status, 200);
  });

  test('a token copied before logout is 401 after it, on every route', async () => {
    const { baseUrl, a } = await twoSessions();
    const copied = a;
    assert.equal((await me(baseUrl, bearer(copied))).status, 200);

    await logout(baseUrl, cookie(a));

    const asBearer = await me(baseUrl, bearer(copied));
    assert.equal(asBearer.status, 401);
    assert.equal(asBearer.body.error.code, 'UNAUTHORIZED');
    const datasets = await api(baseUrl, '/api/datasets', { headers: bearer(copied) });
    assert.equal(datasets.status, 401);
  });

  test('every token the session held is revoked, including slid re-issues', async () => {
    const { baseUrl, clock, a } = await twoSessions();
    clock.advance(500);
    const slid = await me(baseUrl, cookie(a));
    const reissued = slid.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
      ?.split(';')[0]
      .slice(SESSION_COOKIE.length + 1);
    assert.ok(reissued && reissued !== a);

    await logout(baseUrl, cookie(reissued));
    assert.equal((await me(baseUrl, bearer(reissued))).status, 401);
    assert.equal((await me(baseUrl, bearer(a))).status, 401, 'same sid, also revoked');
  });

  test('signing in again starts a new, working session', async () => {
    const { baseUrl, a, login, config } = await twoSessions();
    await logout(baseUrl, cookie(a));
    const fresh = await login();
    assert.notEqual(sidOf(fresh, config.jwtSecret), sidOf(a, config.jwtSecret));
    assert.equal((await me(baseUrl, bearer(fresh))).status, 200);
    assert.equal((await me(baseUrl, bearer(a))).status, 401);
  });

  test('revoked sids are pruned once no token of theirs can be alive', async () => {
    const { baseUrl, db, id, clock, a, b, login, config } = await twoSessions();
    const c = await login();

    await logout(baseUrl, cookie(a)); // t = 0, kept until t = 900
    clock.advance(300);
    await logout(baseUrl, cookie(b)); // t = 300, kept until t = 1200
    assert.deepEqual(revokedSids(db, id), [a, b].map((t) => sidOf(t, config.jwtSecret)));

    // At t = 900 A's entry has expired: any token of A died at t <= 900.
    clock.advance(600);
    const d = await login();
    await logout(baseUrl, cookie(d));
    assert.deepEqual(
      revokedSids(db, id),
      [b, d].map((t) => sidOf(t, config.jwtSecret)),
      'A pruned on write; B still inside its window',
    );
    const entry = JSON.parse(row(db, id).revoked_sessions)[1];
    assert.equal(entry.until, Math.floor(clock.now() / 1000) + TTL);

    // C was never signed out and outlived all of it... until its own TTL.
    assert.equal((await me(baseUrl, bearer(c))).status, 401, 'C simply expired');
  });
});

describe('POST /api/auth/logout-all — every session', () => {
  test('logout-all kills both sessions, then a new sign-in works', async () => {
    const { baseUrl, a, b, login, db, id } = await twoSessions();

    assert.equal((await logoutAll(baseUrl, bearer(b))).status, 204);

    for (const token of [a, b]) {
      assert.equal((await me(baseUrl, bearer(token))).status, 401);
      assert.equal((await me(baseUrl, cookie(token))).status, 401);
    }
    assert.equal(row(db, id).token_version, 1);
    assert.equal(row(db, id).revoked_sessions, '[]', 'the per-session list is redundant now');
    assert.equal((await me(baseUrl, bearer(await login()))).status, 200);
  });

  test('other users are untouched by either logout', async () => {
    const first = await twoSessions();
    const { baseUrl } = first;
    const other = await api(baseUrl, '/api/auth/register', {
      method: 'POST',
      json: { email: `other.${Date.now()}@example.com`, password: PASSWORD },
    });
    await logout(baseUrl, bearer(first.a));
    await logoutAll(baseUrl, bearer(first.b));
    assert.equal((await me(baseUrl, bearer(other.body.token))).status, 200);
  });
});

describe('only a still-valid token can log anyone out', () => {
  test('a replayed pre-logout token is 401 and revokes nothing further', async () => {
    const { baseUrl, db, id, a, b } = await twoSessions();
    await logout(baseUrl, cookie(a));
    const before = row(db, id);

    // Replaying the stolen, already-revoked A at either endpoint: the cookie
    // is cleared, but B must keep working and nothing may change.
    assert.equal((await me(baseUrl, bearer(a))).status, 401);
    assert.equal((await logout(baseUrl, bearer(a))).status, 204);
    assert.equal((await logoutAll(baseUrl, bearer(a))).status, 204);

    assert.deepEqual(row(db, id), before);
    assert.equal((await me(baseUrl, bearer(b))).status, 200);
  });

  test('a token from before logout-all cannot trigger another logout-all', async () => {
    const { baseUrl, db, id, a, b, login } = await twoSessions();
    await logoutAll(baseUrl, bearer(a));
    const fresh = await login();

    await logoutAll(baseUrl, bearer(b)); // b predates the bump
    assert.equal(row(db, id).token_version, 1);
    assert.equal((await me(baseUrl, bearer(fresh))).status, 200);
  });

  test('no credentials, or garbage, is 204 and revokes nothing', async () => {
    const { baseUrl, db, id, a } = await twoSessions();
    const before = row(db, id);
    for (const path of ['/api/auth/logout', '/api/auth/logout-all']) {
      assert.equal((await post(baseUrl, path)).status, 204);
      assert.equal((await post(baseUrl, path, bearer('not-a-token'))).status, 204);
      assert.equal((await post(baseUrl, path, cookie('x.y.z'))).status, 204);
    }
    assert.deepEqual(row(db, id), before);
    assert.equal((await me(baseUrl, bearer(a))).status, 200);
  });
});

describe('token claims', () => {
  test('a token needs sub, integer ver and a sid', async () => {
    const { baseUrl, config, clock, id, a } = await twoSessions();
    const payload = verifyToken(a, config.jwtSecret, clock.now());
    assert.equal(payload.ver, 0);
    assert.equal(typeof payload.sid, 'string');

    const sign = (claims) => signToken(claims, config.jwtSecret, 60, clock.now());
    const cases = {
      noVersion: sign({ sub: id, sid: 's1' }),
      futureVersion: sign({ sub: id, ver: 1, sid: 's1' }),
      stringVersion: sign({ sub: id, ver: '0', sid: 's1' }),
      noSid: sign({ sub: id, ver: 0 }),
      emptySid: sign({ sub: id, ver: 0, sid: '' }),
      numericSid: sign({ sub: id, ver: 0, sid: 7 }),
    };
    for (const [name, token] of Object.entries(cases)) {
      assert.equal((await me(baseUrl, bearer(token))).status, 401, name);
    }
    assert.equal((await me(baseUrl, bearer(sign({ sub: id, ver: 0, sid: 's1' })))).status, 200);
  });
});

describe('schema and configuration', () => {
  test('an old database gains token_version and revoked_sessions', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`);
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('u1', 'a@b.c', 'h', 'now');

    applySchema(db);
    applySchema(db); // idempotent

    const user = db.prepare('SELECT token_version, revoked_sessions FROM users').get();
    assert.deepEqual({ ...user }, { token_version: 0, revoked_sessions: '[]' });
    db.close();
  });

  test('the production image and .env.example both set 15 minutes', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    const env = /^ENV\s+((?:.*\\\r?\n)*.*)$/m.exec(dockerfile)?.[1] ?? '';
    assert.match(env, /\bJWT_EXPIRES_IN=900\b/);
    const example = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
    assert.match(example, /^JWT_EXPIRES_IN=900\r?$/m);
  });
});
