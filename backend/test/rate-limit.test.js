import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { api, registerUser } from './helpers.js';
import { startServerWith } from './harness.js';
import { createRateLimiter } from '../src/auth/rateLimit.js';
import { ConfigError, loadConfig } from '../src/config.js';

/** A clock the test moves by hand. Nothing here sleeps. */
function manualClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

const PASSWORD = 'correct-horse-9';

/** A login attempt that fails on credentials, so only the limiter varies. */
const badLogin = (baseUrl, headers = {}) =>
  api(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers,
    json: { email: 'nobody@example.com', password: 'wrong-password-1' },
  });

describe('auth rate limit', () => {
  test('the N+1th login in a minute is 429 RATE_LIMITED with Retry-After', async () => {
    const clock = manualClock();
    const { baseUrl } = await startServerWith(
      { llm: null, now: clock.now },
      { AUTH_RATE_LIMIT_PER_MIN: '3' },
    );

    for (let i = 0; i < 3; i += 1) {
      assert.equal((await badLogin(baseUrl)).status, 401, `attempt ${i + 1}`);
    }
    const limited = await badLogin(baseUrl);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    assert.match(limited.body.error.message, /Try again in 60 seconds/);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.deepEqual(Object.keys(limited.body), ['error']);
  });

  test('the default is 10 a minute', async () => {
    const clock = manualClock();
    const { baseUrl, config } = await startServerWith({ llm: null, now: clock.now });
    assert.equal(config.authRateLimitPerMin, 10);

    for (let i = 0; i < 10; i += 1) {
      assert.equal((await badLogin(baseUrl)).status, 401, `attempt ${i + 1}`);
    }
    assert.equal((await badLogin(baseUrl)).status, 429);
  });

  test('register and login share one budget, and a success still counts', async () => {
    const clock = manualClock();
    const { baseUrl } = await startServerWith(
      { llm: null, now: clock.now },
      { AUTH_RATE_LIMIT_PER_MIN: '2' },
    );

    const user = await registerUser(baseUrl, PASSWORD);
    const login = await api(baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email: user.email, password: PASSWORD },
    });
    assert.equal(login.status, 200);

    const third = await api(baseUrl, '/api/auth/register', {
      method: 'POST',
      json: { email: 'third@example.com', password: PASSWORD },
    });
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'RATE_LIMITED');
  });

  test('Retry-After counts down, and the limit resets once the window passes', async () => {
    const clock = manualClock();
    const { baseUrl } = await startServerWith(
      { llm: null, now: clock.now },
      { AUTH_RATE_LIMIT_PER_MIN: '2' },
    );

    await badLogin(baseUrl); // t = 0
    clock.advance(20_000);
    await badLogin(baseUrl); // t = 20 s

    clock.advance(25_500); // t = 45.5 s: the first hit leaves at 60 s
    const early = await badLogin(baseUrl);
    assert.equal(early.status, 429);
    assert.equal(early.headers.get('retry-after'), '15', '14.5 s, rounded up');

    clock.advance(14_499); // t = 59.999 s: still inside
    assert.equal((await badLogin(baseUrl)).status, 429);

    clock.advance(1); // t = 60 s: the first hit has left; one slot is free
    assert.equal((await badLogin(baseUrl)).status, 401);
    // Sliding, not bucketed: the 20 s hit and the 60 s hit still fill it.
    const refilled = await badLogin(baseUrl);
    assert.equal(refilled.status, 429);
    assert.equal(refilled.headers.get('retry-after'), '20');

    clock.advance(60_000); // everything has aged out
    assert.equal((await badLogin(baseUrl)).status, 401);
    assert.equal((await badLogin(baseUrl)).status, 401);
  });

  test('rejected requests do not extend the lockout', async () => {
    const clock = manualClock();
    const { baseUrl } = await startServerWith(
      { llm: null, now: clock.now },
      { AUTH_RATE_LIMIT_PER_MIN: '1' },
    );

    await badLogin(baseUrl);
    for (let i = 0; i < 20; i += 1) {
      clock.advance(1_000);
      assert.equal((await badLogin(baseUrl)).status, 429);
    }
    clock.advance(40_000); // 60 s after the only counted request
    assert.equal((await badLogin(baseUrl)).status, 401);
  });

  test('non-auth routes are unaffected while auth is limited', async () => {
    const clock = manualClock();
    const { baseUrl } = await startServerWith(
      { llm: null, now: clock.now },
      { AUTH_RATE_LIMIT_PER_MIN: '1' },
    );

    const user = await registerUser(baseUrl, PASSWORD); // uses the only slot
    assert.equal((await badLogin(baseUrl)).status, 429);

    for (let i = 0; i < 15; i += 1) {
      assert.equal((await api(baseUrl, '/api/health')).status, 200);
      const me = await api(baseUrl, '/api/auth/me', { token: user.token });
      assert.equal(me.status, 200);
      const list = await api(baseUrl, '/api/datasets', { token: user.token });
      assert.equal(list.status, 200);
    }
    const out = await api(baseUrl, '/api/auth/logout', { method: 'POST' });
    assert.equal(out.status, 204, 'logout is never locked out');
  });

  test('each app has its own counters', async () => {
    const clock = manualClock();
    const overrides = { AUTH_RATE_LIMIT_PER_MIN: '1' };
    const first = await startServerWith({ llm: null, now: clock.now }, overrides);
    const second = await startServerWith({ llm: null, now: clock.now }, overrides);

    await badLogin(first.baseUrl);
    assert.equal((await badLogin(first.baseUrl)).status, 429);
    assert.equal((await badLogin(second.baseUrl)).status, 401);
  });
});

describe('client IP and proxies', () => {
  test('by default X-Forwarded-For is ignored, so it cannot dodge the limit', async () => {
    const clock = manualClock();
    const { baseUrl } = await startServerWith(
      { llm: null, now: clock.now },
      { AUTH_RATE_LIMIT_PER_MIN: '1' },
    );

    await badLogin(baseUrl, { 'x-forwarded-for': '203.0.113.1' });
    const spoofed = await badLogin(baseUrl, { 'x-forwarded-for': '203.0.113.2' });
    assert.equal(spoofed.status, 429);
  });

  test('with TRUST_PROXY=1 each forwarded client gets its own budget', async () => {
    const clock = manualClock();
    const { baseUrl } = await startServerWith(
      { llm: null, now: clock.now },
      { AUTH_RATE_LIMIT_PER_MIN: '1', TRUST_PROXY: '1' },
    );

    const a = { 'x-forwarded-for': '203.0.113.1' };
    const b = { 'x-forwarded-for': '203.0.113.2' };
    assert.equal((await badLogin(baseUrl, a)).status, 401);
    assert.equal((await badLogin(baseUrl, a)).status, 429);
    assert.equal((await badLogin(baseUrl, b)).status, 401);
    // Only one hop is trusted: a client-prepended address is not believed.
    const chained = { 'x-forwarded-for': '198.51.100.9, 203.0.113.1' };
    assert.equal((await badLogin(baseUrl, chained)).status, 429);
  });
});

describe('TRUST_PROXY on versus off, same traffic', () => {
  /** Two clients, as a proxy would present them, one attempt each after a first. */
  async function twoForwardedClients(overrides) {
    const clock = manualClock();
    const { baseUrl } = await startServerWith(
      { llm: null, now: clock.now },
      { AUTH_RATE_LIMIT_PER_MIN: '1', ...overrides },
    );
    const first = await badLogin(baseUrl, { 'x-forwarded-for': '198.51.100.10' });
    const second = await badLogin(baseUrl, { 'x-forwarded-for': '198.51.100.20' });
    return [first.status, second.status];
  }

  test('on: two forwarded IPs get separate buckets', async () => {
    assert.deepEqual(await twoForwardedClients({ TRUST_PROXY: '1' }), [401, 401]);
  });

  test('off: the same two forwarded IPs share one bucket', async () => {
    assert.deepEqual(await twoForwardedClients({ TRUST_PROXY: '0' }), [401, 429]);
    assert.deepEqual(await twoForwardedClients({}), [401, 429], 'off is the default');
  });

  test('the production image turns it on', async () => {
    const { readFile } = await import('node:fs/promises');
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    const env = /^ENV\s+((?:.*\\\r?\n)*.*)$/m.exec(dockerfile)?.[1] ?? '';
    assert.match(env, /\bTRUST_PROXY=1\b/);
    assert.match(env, /\bNODE_ENV=production\b/);
  });
});

describe('limiter unit and config', () => {
  test('keys that go quiet are swept, so memory does not grow without bound', () => {
    const clock = manualClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: clock.now });
    const run = (ip) => {
      let outcome;
      const res = { set() {} };
      limiter({ ip }, res, (err) => {
        outcome = err ? err.status : 'ok';
      });
      return outcome;
    };

    for (let i = 0; i < 50; i += 1) run(`10.0.1.${i}`);
    assert.equal(run('10.0.0.1'), 'ok');
    assert.equal(run('10.0.0.1'), 429);
    assert.equal(limiter.trackedKeys(), 51);

    clock.advance(1_000);
    // The first call after a full window sweeps every aged-out client.
    assert.equal(run('10.0.0.2'), 'ok');
    assert.equal(limiter.trackedKeys(), 1);
    assert.equal(run('10.0.0.1'), 'ok');
    assert.equal(run(undefined), 'ok', 'a request with no IP is still limited, not crashed');
    assert.equal(run(undefined), 429);
  });

  test('config validates both variables', () => {
    const base = { JWT_SECRET: 'z'.repeat(40) };
    assert.equal(loadConfig(base).authRateLimitPerMin, 10);
    assert.equal(loadConfig(base).trustProxy, 0);
    assert.equal(loadConfig({ ...base, AUTH_RATE_LIMIT_PER_MIN: '25' }).authRateLimitPerMin, 25);
    assert.equal(loadConfig({ ...base, TRUST_PROXY: '2' }).trustProxy, 2);
    for (const bad of ['0', '-1', '1.5', 'ten']) {
      assert.throws(
        () => loadConfig({ ...base, AUTH_RATE_LIMIT_PER_MIN: bad }),
        ConfigError,
        bad,
      );
    }
    for (const bad of ['-1', 'yes', '0.5']) {
      assert.throws(() => loadConfig({ ...base, TRUST_PROXY: bad }), /non-negative/, bad);
    }
  });
});
