import { after } from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';

/**
 * Boots the real app against an in-memory SQLite database on an ephemeral
 * port. Nothing here stubs application code — only the database location and
 * the port differ from production, so a passing test exercises real behaviour.
 */
export async function startTestServer(overrides = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-only-secret-value-at-least-32-characters-long',
    DATABASE_URL: ':memory:',
    ...overrides,
  });

  const db = openDatabase(config.databaseUrl);
  const app = createApp(config, db);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const close = () =>
    new Promise((resolve) => {
      server.close(() => {
        db.close();
        resolve();
      });
    });

  after(close);
  return { baseUrl, db, config, close };
}

/** Thin fetch wrapper that returns status and parsed body together. */
export async function api(baseUrl, path, options = {}) {
  const { token, json, csv, ...rest } = options;
  const headers = { ...(rest.headers ?? {}) };
  let body = rest.body;

  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (csv !== undefined) {
    headers['content-type'] = 'text/csv';
    body = csv;
  }
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, { ...rest, headers, body });
  const text = await response.text();
  let parsed = text;
  if (response.headers.get('content-type')?.includes('application/json')) {
    parsed = text === '' ? null : JSON.parse(text);
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

let counter = 0;

/** Registers a fresh user and returns its token. */
export async function registerUser(baseUrl, password = 'correct-horse-9') {
  counter += 1;
  const email = `user${counter}.${Date.now()}@example.com`;
  const { status, body } = await api(baseUrl, '/api/auth/register', {
    method: 'POST',
    json: { email, password },
  });
  if (status !== 201) {
    throw new Error(`register failed: ${status} ${JSON.stringify(body)}`);
  }
  return { email, password, token: body.token, user: body.user };
}

export const SAMPLE_CSV = [
  'name,team,score,minutes,joined',
  'Ada,Blue,42,90,2021-03-01',
  'Grace,Red,37,85,2020-07-14',
  'Linus,Blue,42,60,2022-01-09',
  'Barbara,Green,15,,2019-11-30',
  'Alan,Red,28,75,2018-06-23',
].join('\n');
