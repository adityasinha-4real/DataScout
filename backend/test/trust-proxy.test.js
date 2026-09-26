import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

import { api } from './helpers.js';
import { startServerWith } from './harness.js';
import { ConfigError, assertStartable, loadConfig } from '../src/config.js';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const SECRET = 'z'.repeat(40);

/**
 * Runs the real entry point with exactly this environment (plus what the OS
 * needs to start a process), so no developer .env or API key can leak in.
 * Resolves when it exits, or when it logs that it is listening (then kills it).
 */
function boot(env) {
  const base = { PATH: process.env.PATH };
  if (process.env.SYSTEMROOT) base.SYSTEMROOT = process.env.SYSTEMROOT;
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', SERVER],
      { env: { ...base, DATABASE_URL: ':memory:', JWT_SECRET: SECRET, ...env } },
    );
    let stdout = '';
    let stderr = '';
    let listening = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!listening && stdout.includes('listening')) {
        listening = true;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code) => resolve({ code, listening, stdout, stderr }));
  });
}

const port = () => String(20000 + Math.floor(Math.random() * 20000));

describe('TRUST_PROXY is fail-safe in production', () => {
  test('config: unset is null, 0 and N are kept, junk is refused', () => {
    assert.equal(loadConfig({ JWT_SECRET: SECRET }).trustProxy, null);
    assert.equal(loadConfig({ JWT_SECRET: SECRET, TRUST_PROXY: '0' }).trustProxy, 0);
    assert.equal(loadConfig({ JWT_SECRET: SECRET, TRUST_PROXY: '2' }).trustProxy, 2);
    for (const bad of ['-1', 'yes', '1.5', 'on']) {
      assert.throws(
        () => loadConfig({ JWT_SECRET: SECRET, TRUST_PROXY: bad }),
        ConfigError,
        bad,
      );
    }
  });

  test('assertStartable: production needs it set (0 counts); other modes do not', () => {
    const prod = (extra = {}) => loadConfig({ JWT_SECRET: SECRET, NODE_ENV: 'production', ...extra });
    assert.throws(() => assertStartable(prod()), /TRUST_PROXY must be set in production\. Measure/);
    assert.doesNotThrow(() => assertStartable(prod({ TRUST_PROXY: '0' })));
    assert.doesNotThrow(() => assertStartable(prod({ TRUST_PROXY: '2' })));
    for (const NODE_ENV of ['development', 'test']) {
      assert.doesNotThrow(() => assertStartable(loadConfig({ JWT_SECRET: SECRET, NODE_ENV })));
    }
  });

  test('the real server refuses to start in production without it, naming the fix', async () => {
    const result = await boot({ NODE_ENV: 'production', PORT: port() });
    assert.equal(result.code, 1);
    assert.equal(result.listening, false);
    assert.match(result.stderr, /Configuration error: TRUST_PROXY must be set in production/);
    assert.match(result.stderr, /Measure the number of proxy hops/);
    assert.match(result.stderr, /DEBUG_IP_ENDPOINT=1/);
  });

  test('the real server starts in production once it is set', async () => {
    const result = await boot({ NODE_ENV: 'production', TRUST_PROXY: '1', PORT: port() });
    assert.equal(result.listening, true, result.stderr);
    assert.doesNotMatch(result.stderr, /Configuration error/);
  });

  test('outside production it may stay unset (off)', async () => {
    const result = await boot({ NODE_ENV: 'development', PORT: port() });
    assert.equal(result.listening, true, result.stderr);
  });

  test('the production image does not hardcode it', async () => {
    const { readFile } = await import('node:fs/promises');
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    const env = /^ENV\s+((?:.*\\\r?\n)*.*)$/m.exec(dockerfile)?.[1] ?? '';
    assert.match(env, /\bNODE_ENV=production\b/);
    assert.doesNotMatch(env, /TRUST_PROXY/);
  });
});

describe('GET /api/_debug/ip', () => {
  const probe = (baseUrl, headers = {}) => api(baseUrl, '/api/_debug/ip', { headers });

  test('not mounted by default, in development or production', async () => {
    for (const NODE_ENV of ['development', 'production']) {
      const { baseUrl } = await startServerWith({ llm: null }, { NODE_ENV });
      const result = await probe(baseUrl);
      assert.equal(result.status, 404, NODE_ENV);
      assert.equal(result.body.error.code, 'NOT_FOUND');
    }
  });

  test('DEBUG_IP_ENDPOINT=0 or blank keeps it unmounted; junk refuses to boot', async () => {
    for (const value of ['0', '']) {
      const { baseUrl } = await startServerWith(
        { llm: null },
        { NODE_ENV: 'production', DEBUG_IP_ENDPOINT: value },
      );
      assert.equal((await probe(baseUrl)).status, 404, JSON.stringify(value));
    }
    for (const bad of ['true', 'yes', '2']) {
      assert.throws(
        () => loadConfig({ JWT_SECRET: SECRET, DEBUG_IP_ENDPOINT: bad }),
        /DEBUG_IP_ENDPOINT must be 0 or 1/,
      );
    }
  });

  test('mounted with DEBUG_IP_ENDPOINT=1, in development and in production', async () => {
    for (const NODE_ENV of ['development', 'production']) {
      const { baseUrl } = await startServerWith(
        { llm: null },
        { NODE_ENV, DEBUG_IP_ENDPOINT: '1' },
      );
      const result = await probe(baseUrl, { 'x-forwarded-for': '203.0.113.7' });
      assert.equal(result.status, 200, NODE_ENV);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.deepEqual(Object.keys(result.body).sort(), [
        'chain',
        'ip',
        'ips',
        'remoteAddress',
        'trustProxy',
        'xForwardedFor',
      ]);
      // Untrusted: the header is shown but not believed.
      assert.equal(result.body.xForwardedFor, '203.0.113.7');
      assert.equal(result.body.ip, result.body.remoteAddress);
      assert.deepEqual(result.body.ips, []);
      assert.equal(result.body.trustProxy, null);
    }
  });

  test('chain[N] is what req.ip becomes with TRUST_PROXY=N', async () => {
    const xff = '203.0.113.7, 198.51.100.2';
    for (const n of [0, 1, 2]) {
      const { baseUrl } = await startServerWith(
        { llm: null },
        { DEBUG_IP_ENDPOINT: '1', TRUST_PROXY: String(n) },
      );
      const { body } = await probe(baseUrl, { 'x-forwarded-for': xff });
      assert.deepEqual(body.chain, [body.remoteAddress, '198.51.100.2', '203.0.113.7']);
      assert.equal(body.ip, body.chain[n], `TRUST_PROXY=${n}`);
      assert.equal(body.trustProxy, n);
    }
  });

  test('the real server warns when it mounts the endpoint', async () => {
    const result = await boot({
      NODE_ENV: 'production',
      TRUST_PROXY: '0',
      DEBUG_IP_ENDPOINT: '1',
      PORT: port(),
    });
    assert.equal(result.listening, true, result.stderr);
    assert.match(result.stderr, /DEBUG_IP_ENDPOINT=1: GET \/api\/_debug\/ip is mounted/);
  });
});
