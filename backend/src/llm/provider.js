/**
 * The only place in the backend that talks to a model API.
 *
 * A provider is an object with one method, `complete({ system, user })`, that
 * resolves to text. Keeping the surface that small is what makes the test
 * double in `backend/test/ask.test.js` honest: it implements the same one
 * method, so every path the route takes with a real provider is a path the
 * tests take too.
 */

import { badGateway } from '../errors.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 1024;

/**
 * `fetchImpl` is injectable so the request shaping and response parsing below
 * can be tested without a network call or an API key.
 */
export function createAnthropicProvider({ apiKey, model, fetchImpl = fetch }) {
  return {
    name: 'anthropic',
    model,

    async complete({ system, user }) {
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: MAX_TOKENS,
            system,
            messages: [{ role: 'user', content: user }],
          }),
        });
      } catch {
        // The key itself must never reach the client, so the message says
        // nothing about what was sent.
        throw badGateway('LLM_REQUEST_FAILED', 'Could not reach the model API.');
      }

      if (!response.ok) {
        throw badGateway(
          'LLM_REQUEST_FAILED',
          `The model API answered ${response.status}.`,
        );
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw badGateway('LLM_BAD_OUTPUT', 'The model API answered with non-JSON.');
      }

      return (payload?.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
    },
  };
}

/**
 * Null when no key is configured. `/ask` then answers 503 and every other
 * route carries on, so the app stays useful with no model set up.
 */
export function createProvider(config, fetchImpl = fetch) {
  if (!config.anthropicApiKey) return null;
  return createAnthropicProvider({
    apiKey: config.anthropicApiKey,
    model: config.llmModel,
    fetchImpl,
  });
}
