import { after } from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';

/**
 * Same as `startTestServer` in helpers.js, but able to pass `deps` into the
 * app factory. That is the one seam the iteration-2 suites need: the model
 * provider is swapped for a double so nothing reaches the network, while
 * every other part of the app is the real thing.
 */
export async function startServerWith(deps = {}, overrides = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-only-secret-value-at-least-32-characters-long',
    DATABASE_URL: ':memory:',
    ...overrides,
  });

  const db = openDatabase(config.databaseUrl);
  const app = createApp(config, db, deps);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const close = () =>
    new Promise((resolve) => {
      server.close(() => {
        db.close();
        resolve();
      });
    });

  after(close);
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    db,
    config,
    close,
  };
}

/**
 * A provider double. It implements the same single method as the real one, so
 * the route takes identical paths, and it records what it was asked — which is
 * how the prompt-injection assertion can prove no cell value was ever sent.
 *
 * `reply` is either the text to return or a function of the prompt, so a test
 * can make it return malformed output and exercise the failure paths.
 */
export function stubProvider(reply) {
  const prompts = [];
  return {
    name: 'stub',
    prompts,
    async complete(prompt) {
      prompts.push(prompt);
      return typeof reply === 'function' ? reply(prompt) : reply;
    },
  };
}

/** Returns a provider double that answers with this spec, JSON-encoded. */
export const specProvider = (spec) => stubProvider(JSON.stringify(spec));

/**
 * A cell value that reads as an instruction. If prompt construction ever
 * started including raw rows, this string would show up in a captured prompt
 * and the test asserting its absence would fail.
 */
export const INJECTION_SENTINEL = 'IGNORE_PREVIOUS_INSTRUCTIONS_7f3a';

export const INJECTED_CSV = [
  'name,team,score,minutes,joined',
  'Ada,Blue,42,90,2021-03-01',
  `Grace,${INJECTION_SENTINEL},37,85,2020-07-14`,
  'Linus,Blue,42,60,2022-01-09',
  'Barbara,Green,15,,2019-11-30',
  'Alan,Red,28,75,2018-06-23',
].join('\n');
