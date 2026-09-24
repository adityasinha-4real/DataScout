import test from 'node:test';
import assert from 'node:assert/strict';

import { api, startTestServer } from './helpers.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { openDatabase, isConnected } from '../src/db/index.js';

const { baseUrl } = await startTestServer();

test('GET /api/health reports ok and a connected database', async () => {
  const { status, body } = await api(baseUrl, '/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.db, 'connected');
  assert.equal(typeof body.uptime, 'number');
});

test('isConnected reports false once the database is closed', () => {
  const db = openDatabase(':memory:');
  assert.equal(isConnected(db), true);
  db.close();
  assert.equal(isConnected(db), false);
});

test('an unknown route returns the standard error envelope', async () => {
  const { status, body } = await api(baseUrl, '/api/nope');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.match(body.error.message, /GET \/api\/nope/);
});

test('every error response has an error.code and error.message', async () => {
  const responses = await Promise.all([
    api(baseUrl, '/api/nope'),
    api(baseUrl, '/api/auth/me'),
    api(baseUrl, '/api/auth/register', { method: 'POST', json: {} }),
    api(baseUrl, '/api/datasets', { method: 'POST', csv: 'a\n1\n' }),
  ]);

  for (const { status, body } of responses) {
    assert.ok(status >= 400);
    assert.equal(typeof body.error.code, 'string');
    assert.equal(typeof body.error.message, 'string');
    assert.ok(body.error.code.length > 0);
  }
});

test('malformed JSON is reported as 400 INVALID_JSON, not a crash', async () => {
  const { status, body } = await api(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_JSON');
});

test('in production, errors carry no stack trace', async () => {
  const prod = await startTestServer({ NODE_ENV: 'production' });
  const { status, body } = await api(prod.baseUrl, '/api/auth/register', {
    method: 'POST',
    json: { email: 'bad', password: 'x' },
  });

  assert.equal(status, 400);
  assert.equal(body.error.stack, undefined);
  assert.ok(!JSON.stringify(body).includes('at '));
});

test('CORS headers reflect the configured origin', async () => {
  const { headers } = await api(baseUrl, '/api/health');
  assert.equal(
    headers.get('access-control-allow-origin'),
    'http://localhost:5173',
  );
});

test('the server does not advertise its framework', async () => {
  const { headers } = await api(baseUrl, '/api/health');
  assert.equal(headers.get('x-powered-by'), null);
});

test('loadConfig applies documented defaults', () => {
  const config = loadConfig({ JWT_SECRET: 'z'.repeat(40) });
  assert.equal(config.port, 4000);
  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.jwtExpiresIn, 3600);
  assert.equal(config.databaseUrl, './data/datascout.db');
  assert.equal(config.maxUploadBytes, 10485760);
  assert.equal(config.isProduction, false);
});

test('loadConfig refuses to boot on a missing or weak JWT_SECRET', () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ JWT_SECRET: '   ' }), ConfigError);
  assert.throws(() => loadConfig({ JWT_SECRET: 'too-short' }), /at least 32/);
});

test('loadConfig rejects a non-numeric port and an unknown NODE_ENV', () => {
  assert.throws(
    () => loadConfig({ JWT_SECRET: 'z'.repeat(40), PORT: 'abc' }),
    /positive integer/,
  );
  assert.throws(
    () => loadConfig({ JWT_SECRET: 'z'.repeat(40), NODE_ENV: 'staging' }),
    /development, test or production/,
  );
});

test('loadConfig leaves process.env untouched', () => {
  const before = process.env.JWT_SECRET;
  loadConfig({ JWT_SECRET: 'z'.repeat(40) });
  assert.equal(process.env.JWT_SECRET, before);
});
