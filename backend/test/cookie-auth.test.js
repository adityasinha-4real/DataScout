import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { api, SAMPLE_CSV } from './helpers.js';
import { startServerWith } from './harness.js';
import { signToken } from '../src/auth/jwt.js';
import {
  SESSION_COOKIE,
  readSessionCookie,
} from '../src/auth/cookie.js';
import { ConfigError, loadConfig } from '../src/config.js';

const SECRET = 'test-only-secret-value-at-least-32-characters-long';
const FRONTEND = 'http://localhost:5173';

let counter = 0;
const freshEmail = () => `cookie${(counter += 1)}.${Date.now()}@example.com`;

/** Attribute map of the session cookie in a response's Set-Cookie headers. */
function sessionCookie(headers) {
  const line = headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  if (!line) return null;
  const [pair, ...attributes] = line.split(';').map((part) => part.trim());
  const flags = {};
  for (const attribute of attributes) {
    const [key, value = true] = attribute.split('=');
    flags[key.toLowerCase()] = value;
  }
  return { value: pair.slice(SESSION_COOKIE.length + 1), flags, raw: line };
}

/** A minimal browser-style jar holding only the session cookie. */
function jar() {
  let value = null;
  return {
    header: () => (value ? `${SESSION_COOKIE}=${value}` : undefined),
    take(headers) {
      const cookie = sessionCookie(headers);
      if (!cookie) return;
      value = cookie.flags['max-age'] === '0' || cookie.value === '' ? null : cookie.value;
    },
  };
}

/** api() with the jar's cookie attached and its Set-Cookie applied. */
async function withJar(cookies, baseUrl, path, options = {}) {
  const cookie = cookies.header();
  const headers = { ...(options.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const result = await api(baseUrl, path, { ...options, headers });
  cookies.take(result.headers);
  return result;
}

async function register(baseUrl, cookies) {
  const result = await withJar(cookies, baseUrl, '/api/auth/register', {
    method: 'POST',
    json: { email: freshEmail(), password: 'correct-horse-9' },
  });
  assert.equal(result.status, 201);
  return result;
}

describe('session cookie', () => {
  test('register sets HttpOnly, SameSite=Lax, Path=/ and no Secure outside production', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const { headers, body } = await register(baseUrl, jar());

    const cookie = sessionCookie(headers);
    assert.ok(cookie, 'a session cookie was set');
    assert.equal(cookie.value, body.token, 'it carries the issued token');
    assert.equal(cookie.flags.httponly, true);
    assert.equal(cookie.flags.samesite, 'Lax');
    assert.equal(cookie.flags.path, '/');
    assert.equal(cookie.flags['max-age'], '3600');
    assert.equal(cookie.flags.secure, undefined, 'plain-http dev and e2e keep working');
  });

  test('login sets the same cookie, and adds Secure when NODE_ENV=production', async () => {
    const { baseUrl } = await startServerWith({ llm: null }, { NODE_ENV: 'production' });
    const email = freshEmail();
    await api(baseUrl, '/api/auth/register', {
      method: 'POST',
      json: { email, password: 'correct-horse-9' },
    });

    const { status, headers, body } = await api(baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email, password: 'correct-horse-9' },
    });
    assert.equal(status, 200);
    const cookie = sessionCookie(headers);
    assert.equal(cookie.value, body.token);
    assert.equal(cookie.flags.secure, true);
    assert.equal(cookie.flags.httponly, true);
    assert.equal(cookie.flags.samesite, 'Lax');
  });

  test('a failed login sets no cookie', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const { status, headers } = await api(baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email: freshEmail(), password: 'wrong-password-1' },
    });
    assert.equal(status, 401);
    assert.equal(sessionCookie(headers), null);
  });

  test('the cookie alone authenticates /me and dataset routes', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const cookies = jar();
    const { body: registered } = await register(baseUrl, cookies);

    const me = await withJar(cookies, baseUrl, '/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, registered.user.id);

    const upload = await withJar(cookies, baseUrl, '/api/datasets', {
      method: 'POST',
      csv: SAMPLE_CSV,
    });
    assert.equal(upload.status, 201);
    const list = await withJar(cookies, baseUrl, '/api/datasets');
    assert.equal(list.body.datasets.length, 1);
  });

  test('the Bearer header still works on its own (C7)', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const { body } = await register(baseUrl, jar());
    const me = await api(baseUrl, '/api/auth/me', { token: body.token });
    assert.equal(me.status, 200);
  });

  test('a Bearer header that is sent wins over the cookie', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const cookies = jar();
    await register(baseUrl, cookies);

    const me = await api(baseUrl, '/api/auth/me', {
      headers: { cookie: cookies.header(), authorization: 'Bearer not-a-token' },
    });
    assert.equal(me.status, 401, 'a bad header is not rescued by a good cookie');
  });

  test('an expired, tampered, foreign-signed or empty cookie is 401', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const { body } = await register(baseUrl, jar());
    const sub = body.user.id;

    const [header, payload, signature] = body.token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'someone-else', exp: 9999999999 }),
    ).toString('base64url');

    const cases = {
      expired: signToken({ sub }, SECRET, -10),
      tamperedPayload: `${header}.${forged}.${signature}`,
      tamperedSignature: `${header}.${payload}.${signature.slice(0, -2)}xx`,
      wrongSecret: signToken({ sub }, 'another-secret-value-at-least-32-characters', 3600),
      empty: '',
    };
    for (const [name, value] of Object.entries(cases)) {
      const me = await api(baseUrl, '/api/auth/me', {
        headers: { cookie: `${SESSION_COOKIE}=${value}` },
      });
      assert.equal(me.status, 401, name);
      assert.equal(me.body.error.code, 'UNAUTHORIZED', name);
    }
  });

  test('logout answers 204, clears the cookie, and /me is then 401', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const cookies = jar();
    await register(baseUrl, cookies);
    assert.equal((await withJar(cookies, baseUrl, '/api/auth/me')).status, 200);

    const out = await withJar(cookies, baseUrl, '/api/auth/logout', { method: 'POST' });
    assert.equal(out.status, 204);
    const cleared = sessionCookie(out.headers);
    assert.equal(cleared.value, '');
    assert.equal(cleared.flags['max-age'], '0');
    // Cleared with the attributes it was set with, so every browser matches it.
    assert.equal(cleared.flags.httponly, true);
    assert.equal(cleared.flags.samesite, 'Lax');
    assert.equal(cleared.flags.path, '/');

    const me = await withJar(cookies, baseUrl, '/api/auth/me');
    assert.equal(me.status, 401);

    // Signing out twice is not an error.
    const again = await withJar(cookies, baseUrl, '/api/auth/logout', { method: 'POST' });
    assert.equal(again.status, 204);
  });

  test('the cookie parser picks the session out of a crowded header', () => {
    assert.equal(readSessionCookie(undefined), null);
    assert.equal(readSessionCookie(''), null);
    assert.equal(readSessionCookie('theme=dark; junk'), null);
    assert.equal(readSessionCookie(`a=1; ${SESSION_COOKIE}=abc.def.ghi; b=2`), 'abc.def.ghi');
    assert.equal(readSessionCookie(`${SESSION_COOKIE}=`), null);
    assert.equal(readSessionCookie(`x${SESSION_COOKIE}=nope`), null);
  });
});

describe('CORS with credentials', () => {
  test('an allowed origin is echoed back with credentials, never *', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const { headers } = await api(baseUrl, '/api/health', {
      headers: { origin: FRONTEND },
    });
    assert.equal(headers.get('access-control-allow-origin'), FRONTEND);
    assert.equal(headers.get('access-control-allow-credentials'), 'true');
    assert.match(headers.get('vary') ?? '', /Origin/);
  });

  test('a non-allowed origin gets no Access-Control-Allow-Origin', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    for (const origin of ['https://evil.example', 'http://localhost:5174', 'null']) {
      const simple = await api(baseUrl, '/api/health', { headers: { origin } });
      assert.equal(simple.headers.get('access-control-allow-origin'), null, origin);

      const preflight = await api(baseUrl, '/api/auth/login', {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      assert.equal(preflight.headers.get('access-control-allow-origin'), null, origin);
    }
  });

  test('every origin in a comma-separated allowlist is accepted', async () => {
    const second = 'https://app.example.com';
    const { baseUrl } = await startServerWith(
      { llm: null },
      { CORS_ORIGIN: `${FRONTEND}, ${second}/` },
    );
    for (const origin of [FRONTEND, second]) {
      const preflight = await api(baseUrl, '/api/auth/login', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
      assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    }
  });

  test('a wildcard or empty CORS_ORIGIN refuses to boot', () => {
    const base = { JWT_SECRET: 'z'.repeat(40) };
    assert.throws(() => loadConfig({ ...base, CORS_ORIGIN: '*' }), ConfigError);
    assert.throws(
      () => loadConfig({ ...base, CORS_ORIGIN: `${FRONTEND},*` }),
      /exact origins/,
    );
    assert.throws(() => loadConfig({ ...base, CORS_ORIGIN: ' , ' }), ConfigError);
    assert.deepEqual(loadConfig(base).corsOrigins, [FRONTEND]);
  });
});
