import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { api, registerUser, SAMPLE_CSV } from './helpers.js';
import { startServerWith } from './harness.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';

/**
 * CSRF surface audit. A browser attaches the SameSite=Lax session cookie to
 * cross-site top-level GET navigations, so a GET route that changes state
 * would be forgeable from any site. This walks the real router stack and
 * checks every route's method against the list below.
 */

// Every route the app serves, classified. Adding a route fails
// "the route table is exactly the audited one" until it is added here, in the
// right list, on purpose.
const READ_ONLY = [
  'GET /api/_debug/ip',
  'GET /api/auth/me',
  'GET /api/datasets',
  'GET /api/datasets/:id',
  'GET /api/datasets/:id/anomalies',
  'GET /api/datasets/:id/export',
  'GET /api/datasets/:id/profile',
  'GET /api/datasets/:id/rows',
  'GET /api/health',
];
const MUTATING = [
  'DELETE /api/datasets/:id',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/logout-all',
  'POST /api/auth/register',
  'POST /api/datasets',
  // /ask writes nothing, but it spends model credits: treat it as a write.
  'POST /api/datasets/:id/ask',
];

// Where app.js mounts routers. A router mounted anywhere else makes the walk
// fail rather than silently skip it.
const MOUNTS = ['/api'];

function mountOf(layer) {
  const found = MOUNTS.find((prefix) => layer.matchers[0](`${prefix}/x`) && !layer.matchers[0]('/x'));
  if (!found) throw new Error(`router "${layer.name}" is mounted at an unknown path`);
  return found;
}

/**
 * Every route in the app, nested routers included, as
 * { key: "METHOD /path", path, handler } where handler is the route's final
 * function (the one that does the work, after any per-route middleware).
 */
function routes(app) {
  const found = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const handler = layer.route.stack.at(-1).handle;
        for (const method of Object.keys(layer.route.methods)) {
          const path = `${prefix}${layer.route.path}`;
          found.push({ key: `${method.toUpperCase()} ${path}`, method, path, handler });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountOf(layer));
      }
    }
  };
  walk(app.router.stack, '');
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

const routeTable = (app) => routes(app).map((r) => r.key);

// Paths whose only purpose is to change state: no GET may exist on them.
const NEVER_GET = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/logout-all',
  '/api/auth/register',
  '/api/datasets/:id/ask',
];

function fullApp() {
  // Every optional route switched on, so the audit covers all of them.
  const config = loadConfig({
    JWT_SECRET: 'z'.repeat(40),
    DEBUG_IP_ENDPOINT: '1',
  });
  return createApp(config, openDatabase(':memory:'), { llm: null });
}

describe('CSRF surface', () => {
  test('the route table is exactly the audited one', () => {
    assert.deepEqual(routeTable(fullApp()), [...READ_ONLY, ...MUTATING].sort());
  });

  test('no mutating handler is reachable by GET (or HEAD)', () => {
    const all = routes(fullApp());
    const reads = all.filter((r) => r.method === 'get' || r.method === 'head');
    const writes = all.filter((r) => MUTATING.includes(r.key));
    assert.equal(writes.length, MUTATING.length, 'every audited write route exists');

    // Denylisted paths: nothing answers GET there.
    for (const read of reads) {
      assert.equal(NEVER_GET.includes(read.path), false, `${read.key} is on the denylist`);
    }
    // Denylisted handlers: no GET route runs a function a write route runs.
    const mutatingHandlers = new Set(writes.map((w) => w.handler));
    for (const read of reads) {
      assert.equal(
        mutatingHandlers.has(read.handler),
        false,
        `${read.key} runs the handler of a state-changing route`,
      );
    }
    assert.deepEqual(reads.map((r) => r.key), READ_ONLY);
  });

  test('a GET to a state-changing path is 404 and changes nothing', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const user = await registerUser(baseUrl);
    const upload = await api(baseUrl, '/api/datasets', {
      method: 'POST',
      token: user.token,
      csv: SAMPLE_CSV,
    });
    const id = upload.body.dataset.id;

    for (const path of [
      '/api/auth/logout',
      '/api/auth/logout-all',
      '/api/auth/login',
      '/api/auth/register',
      `/api/datasets/${id}/ask`,
    ]) {
      const result = await api(baseUrl, path, { token: user.token });
      assert.equal(result.status, 404, `GET ${path}`);
      assert.equal(
        result.headers.getSetCookie().length,
        0,
        `GET ${path} must not touch the cookie`,
      );
    }
    // The session and the dataset survived every one of those GETs.
    assert.equal((await api(baseUrl, '/api/auth/me', { token: user.token })).status, 200);
    const list = await api(baseUrl, '/api/datasets', { token: user.token });
    assert.deepEqual(list.body.datasets.map((d) => d.id), [id]);
  });
});
