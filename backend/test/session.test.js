import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { api } from './helpers.js';
import { startServerWith } from './harness.js';
import { verifyToken } from '../src/auth/jwt.js';
import { SESSION_COOKIE } from '../src/auth/cookie.js';
import { loadConfig } from '../src/config.js';

const PASSWORD = 'correct-horse-9';
const TTL = 900;

/** A clock the test moves by hand; starts on a whole second. */
function manualClock() {
  let now = 1_800_000_000_000;
  return { now: () => now, advance: (s) => (now += s * 1000) };
}

let counter = 0;

/** Boots an app on a manual clock and signs a fresh user in. */
async function signedIn(overrides = {}) {
  const clock = manualClock();
  const server = await startServerWith({ llm: null, now: clock.now }, overrides);
  counter += 1;
  const result = await api(server.baseUrl, '/api/auth/register', {
    method: 'POST',
    json: { email: `slide${counter}.${Date.now()}@example.com`, password: PASSWORD },
  });
  assert.equal(result.status, 201);
  return { ...server, clock, token: result.body.token, user: result.body.user };
}

/** The session cookie a response set, with its attributes, or null. */
function reissued(headers) {
  const line = headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!line) return null;
  const [pair, ...attrs] = line.split(';').map((p) => p.trim());
  return { token: pair.slice(SESSION_COOKIE.length + 1), attrs };
}

const withCookie = (baseUrl, path, token, options = {}) =>
  api(baseUrl, path, {
    ...options,
    headers: { ...(options.headers ?? {}), cookie: `${SESSION_COOKIE}=${token}` },
  });

describe('token TTL', () => {
  test('the code default is 15 minutes', () => {
    assert.equal(loadConfig({ JWT_SECRET: 'z'.repeat(40) }).jwtExpiresIn, TTL);
  });
});

describe('sliding session re-issue', () => {
  test('before half-life: authenticated, no new cookie', async () => {
    const { baseUrl, clock, token } = await signedIn();
    clock.advance(TTL / 2 - 1); // 449 s

    const me = await withCookie(baseUrl, '/api/auth/me', token);
    assert.equal(me.status, 200);
    assert.equal(reissued(me.headers), null);
  });

  test('past half-life: the same cookie is re-set with a fresh token', async () => {
    const { baseUrl, clock, token, config, user } = await signedIn();
    clock.advance(TTL / 2); // exactly half: 450 s

    const me = await withCookie(baseUrl, '/api/auth/me', token);
    assert.equal(me.status, 200);
    const cookie = reissued(me.headers);
    assert.ok(cookie, 'a new session cookie was set');
    assert.notEqual(cookie.token, token);
    assert.deepEqual(cookie.attrs, ['Path=/', `Max-Age=${TTL}`, 'HttpOnly', 'SameSite=Lax']);

    const old = verifyToken(token, config.jwtSecret, clock.now());
    const fresh = verifyToken(cookie.token, config.jwtSecret, clock.now());
    assert.equal(fresh.sub, user.id);
    assert.equal(fresh.ver, old.ver, 'carries the current tokenVersion');
    assert.equal(fresh.iat, old.iat + TTL / 2);
    assert.equal(fresh.exp, fresh.iat + TTL);
  });

  test('re-issue works on any authenticated route, not just /me', async () => {
    const { baseUrl, clock, token } = await signedIn();
    clock.advance(600);
    const list = await withCookie(baseUrl, '/api/datasets', token);
    assert.equal(list.status, 200);
    assert.ok(reissued(list.headers));
  });

  test('in production the re-issued cookie is Secure too', async () => {
    const { baseUrl, clock, token } = await signedIn({ NODE_ENV: 'production' });
    clock.advance(500);
    const cookie = reissued((await withCookie(baseUrl, '/api/auth/me', token)).headers);
    assert.deepEqual(cookie.attrs, [
      'Path=/',
      `Max-Age=${TTL}`,
      'HttpOnly',
      'SameSite=Lax',
      'Secure',
    ]);
  });

  test('an active session outlives the TTL; an idle one does not', async () => {
    const { baseUrl, clock, token } = await signedIn();
    let current = token;
    // Four requests 600 s apart: 2400 s in total, well past one 900 s TTL.
    for (let i = 0; i < 4; i += 1) {
      clock.advance(600);
      const me = await withCookie(baseUrl, '/api/auth/me', current);
      assert.equal(me.status, 200, `request ${i + 1}`);
      current = reissued(me.headers)?.token ?? current;
    }
    assert.notEqual(current, token);
    // The very first token lapsed long ago.
    assert.equal((await withCookie(baseUrl, '/api/auth/me', token)).status, 401);
  });

  test('an expired token is 401 and is not re-issued', async () => {
    const { baseUrl, clock, token } = await signedIn();
    clock.advance(TTL);

    const me = await withCookie(baseUrl, '/api/auth/me', token);
    assert.equal(me.status, 401);
    assert.equal(reissued(me.headers), null);
  });

  test('Bearer requests are never given a cookie', async () => {
    const { baseUrl, clock, token } = await signedIn();
    clock.advance(800);
    const me = await api(baseUrl, '/api/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(reissued(me.headers), null);
  });

  test('a re-issued token still fails after logout', async () => {
    const { baseUrl, clock, token } = await signedIn();
    clock.advance(500);
    const fresh = reissued((await withCookie(baseUrl, '/api/auth/me', token)).headers).token;
    assert.equal((await withCookie(baseUrl, '/api/auth/me', fresh)).status, 200);

    const out = await withCookie(baseUrl, '/api/auth/logout', fresh, { method: 'POST' });
    assert.equal(out.status, 204);
    for (const t of [token, fresh]) {
      const me = await withCookie(baseUrl, '/api/auth/me', t);
      assert.equal(me.status, 401);
      assert.equal(reissued(me.headers), null, 'a refused token is never refreshed');
    }
  });
});
