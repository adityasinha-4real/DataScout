import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { api, registerUser } from './helpers.js';
import {
  INJECTED_CSV,
  INJECTION_SENTINEL,
  specProvider,
  startServerWith,
  stubProvider,
} from './harness.js';
import { createAnthropicProvider } from '../src/llm/provider.js';
import {
  QUERY_SPEC_SCHEMA,
  buildPrompt,
  describeColumns,
  explainSpec,
  parseSpec,
  resolveSpec,
  validateAgainstSchema,
} from '../src/llm/querySpec.js';
import { profileDataset } from '../src/csv/profile.js';
import { parseCsv } from '../src/csv/parse.js';

/** Upload the fixture and return the ids a test needs to drive /ask. */
async function seed(baseUrl) {
  const owner = await registerUser(baseUrl);
  const { status, body } = await api(baseUrl, '/api/datasets?name=Players', {
    method: 'POST',
    token: owner.token,
    csv: INJECTED_CSV,
  });
  assert.equal(status, 201);
  return { owner, datasetId: body.dataset.id };
}

const ask = (baseUrl, datasetId, token, question) =>
  api(baseUrl, `/api/datasets/${datasetId}/ask`, {
    method: 'POST',
    token,
    json: { question },
  });

describe('POST /api/datasets/:id/ask', () => {
  test('runs a validated spec through the query engine', async () => {
    const llm = specProvider({
      filters: [{ column: 'score', operator: 'gte', value: '37' }],
      rankBy: 'score',
    });
    const { baseUrl } = await startServerWith({ llm });
    const { owner, datasetId } = await seed(baseUrl);

    const { status, body } = await ask(
      baseUrl,
      datasetId,
      owner.token,
      'who scored at least 37, best first?',
    );

    assert.equal(status, 200);
    assert.deepEqual(body.spec.filters, [
      { column: 'score', operator: 'gte', value: '37' },
    ]);
    assert.equal(body.total, 3);
    assert.deepEqual(
      body.rows.map((entry) => entry.row[0]),
      ['Ada', 'Linus', 'Grace'],
    );
    // Dense ranking: the two 42s tie at 1 and 37 takes 2, not 3.
    assert.deepEqual(
      body.rows.map((entry) => entry.rank),
      [1, 1, 2],
    );
    assert.equal(
      body.explanation,
      'Kept rows where score is at least 37, ranked them by score, highest first.',
    );
  });

  test('sends column names, types and stats — never a cell value', async () => {
    const llm = specProvider({ filters: [] });
    const { baseUrl } = await startServerWith({ llm });
    const { owner, datasetId } = await seed(baseUrl);

    await ask(baseUrl, datasetId, owner.token, 'show me everything');

    assert.equal(llm.prompts.length, 1);
    const sent = `${llm.prompts[0].system}\n${llm.prompts[0].user}`;

    // The catalogue is there...
    assert.match(sent, /"name": "score"/);
    assert.match(sent, /"type": "number"/);
    assert.match(sent, /"median": 37/);

    // ...and nothing from inside the table is. A cell that reads as an
    // instruction cannot reach the model, so it cannot redirect it.
    assert.ok(
      !sent.includes(INJECTION_SENTINEL),
      'a raw cell value reached the prompt',
    );
    for (const cell of ['Ada', 'Grace', 'Barbara', 'Blue', 'Green']) {
      assert.ok(!sent.includes(cell), `cell value "${cell}" reached the prompt`);
    }
  });

  test('a question is passed through verbatim and bounded to 500 characters', async () => {
    const llm = specProvider({ filters: [] });
    const { baseUrl } = await startServerWith({ llm });
    const { owner, datasetId } = await seed(baseUrl);

    await ask(baseUrl, datasetId, owner.token, 'top scorers on Blue');
    assert.match(llm.prompts[0].user, /top scorers on Blue/);

    const tooLong = await ask(baseUrl, datasetId, owner.token, 'a'.repeat(501));
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, 'VALIDATION_ERROR');

    const empty = await ask(baseUrl, datasetId, owner.token, '   ');
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'VALIDATION_ERROR');

    // The model was never called for either rejected question.
    assert.equal(llm.prompts.length, 1);
  });

  test('a spec naming a column the dataset does not have is 422 with no rows', async () => {
    const llm = specProvider({
      filters: [{ column: 'salary', operator: 'gt', value: '100' }],
    });
    const { baseUrl } = await startServerWith({ llm });
    const { owner, datasetId } = await seed(baseUrl);

    const { status, body } = await ask(
      baseUrl,
      datasetId,
      owner.token,
      'who earns the most?',
    );

    assert.equal(status, 422);
    assert.equal(body.error.code, 'UNRESOLVABLE_QUERY');
    assert.match(body.error.message, /salary/);
    assert.equal(body.rows, undefined);
  });

  test('an operator the column type cannot support is 422', async () => {
    const llm = specProvider({
      filters: [{ column: 'score', operator: 'contains', value: '4' }],
    });
    const { baseUrl } = await startServerWith({ llm });
    const { owner, datasetId } = await seed(baseUrl);

    const { status, body } = await ask(baseUrl, datasetId, owner.token, 'scores with a 4');
    assert.equal(status, 422);
    assert.equal(body.error.code, 'UNRESOLVABLE_QUERY');
    assert.match(body.error.message, /contains.*score.*number/);
  });

  test('ranking by a non-numeric column is 422', async () => {
    const llm = specProvider({ rankBy: 'team' });
    const { baseUrl } = await startServerWith({ llm });
    const { owner, datasetId } = await seed(baseUrl);

    const { status, body } = await ask(baseUrl, datasetId, owner.token, 'best team');
    assert.equal(status, 422);
    assert.equal(body.error.code, 'UNRESOLVABLE_QUERY');
    assert.match(body.error.message, /rankBy/);
  });

  test('output that is not JSON is 502', async () => {
    const llm = stubProvider('Sure! Here are the top players: Ada and Linus.');
    const { baseUrl } = await startServerWith({ llm });
    const { owner, datasetId } = await seed(baseUrl);

    const { status, body } = await ask(baseUrl, datasetId, owner.token, 'top players');
    assert.equal(status, 502);
    assert.equal(body.error.code, 'LLM_BAD_OUTPUT');
  });

  test('JSON that is not a QuerySpec is 502', async () => {
    const llm = specProvider({ filters: [], sqlQuery: 'DROP TABLE datasets' });
    const { baseUrl } = await startServerWith({ llm });
    const { owner, datasetId } = await seed(baseUrl);

    const { status, body } = await ask(baseUrl, datasetId, owner.token, 'drop everything');
    assert.equal(status, 502);
    assert.equal(body.error.code, 'LLM_BAD_OUTPUT');
    assert.match(body.error.message, /sqlQuery/);
  });

  test('a fenced answer is repaired rather than rejected', async () => {
    const llm = stubProvider(
      '```json\n{"filters":[{"column":"team","operator":"eq","value":"Blue"}]}\n```',
    );
    const { baseUrl } = await startServerWith({ llm });
    const { owner, datasetId } = await seed(baseUrl);

    const { status, body } = await ask(baseUrl, datasetId, owner.token, 'the Blue team');
    assert.equal(status, 200);
    assert.equal(body.total, 2);
  });

  test('with no API key /ask is 503 and every other route still works', async () => {
    // No `llm` in deps and no ANTHROPIC_API_KEY, so the app builds exactly
    // what production would build on a server with no model configured.
    const { baseUrl } = await startServerWith({});
    const { owner, datasetId } = await seed(baseUrl);

    const asked = await ask(baseUrl, datasetId, owner.token, 'who is top?');
    assert.equal(asked.status, 503);
    assert.equal(asked.body.error.code, 'LLM_UNAVAILABLE');

    const profile = await api(baseUrl, `/api/datasets/${datasetId}/profile`, {
      token: owner.token,
    });
    assert.equal(profile.status, 200);

    const rows = await api(
      baseUrl,
      `/api/datasets/${datasetId}/rows?filter=team:eq:Blue`,
      { token: owner.token },
    );
    assert.equal(rows.status, 200);
    assert.equal(rows.body.total, 2);
  });

  test('another user asking about this dataset gets 404, not 403', async () => {
    const llm = specProvider({ filters: [] });
    const { baseUrl } = await startServerWith({ llm });
    const { datasetId } = await seed(baseUrl);
    const stranger = await registerUser(baseUrl);

    const { status, body } = await ask(
      baseUrl,
      datasetId,
      stranger.token,
      'what is in here?',
    );
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
    // The dataset was never read, so the model was never asked about it.
    assert.equal(llm.prompts.length, 0);
  });

  test('asking without a token is 401', async () => {
    const llm = specProvider({ filters: [] });
    const { baseUrl } = await startServerWith({ llm });
    const { datasetId } = await seed(baseUrl);

    const { status, body } = await api(baseUrl, `/api/datasets/${datasetId}/ask`, {
      method: 'POST',
      json: { question: 'anything' },
    });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });
});

describe('QuerySpec schema validation', () => {
  const valid = (value) => validateAgainstSchema(value, QUERY_SPEC_SCHEMA);

  test('accepts an empty spec and a fully populated one', () => {
    assert.deepEqual(valid({}), []);
    assert.deepEqual(
      valid({
        filters: [
          { column: 'team', operator: 'eq', value: 'Blue' },
          { column: 'minutes', operator: 'notEmpty' },
        ],
        sort: 'name',
        direction: 'asc',
        rankBy: 'score',
        limit: 10,
      }),
      [],
    );
  });

  test('rejects the shapes a model actually gets wrong', () => {
    assert.match(valid([])[0], /must be a object/);
    assert.match(valid({ filters: {} })[0], /filters must be a array/);
    assert.match(valid({ direction: 'descending' })[0], /must be one of asc, desc/);
    assert.match(valid({ limit: 0 })[0], /at least 1/);
    assert.match(valid({ limit: 5000 })[0], /at most 1000/);
    assert.match(valid({ limit: 1.5 })[0], /must be a integer/);
    assert.match(valid({ sort: '' })[0], /must not be empty/);
    assert.match(valid({ notAField: 1 })[0], /not a field of QuerySpec/);
    assert.match(valid({ filters: [{ column: 'a' }] })[0], /operator is required/);
    assert.match(
      valid({ filters: [{ column: 'a', operator: 'regex', value: '.' }] })[0],
      /must be one of/,
    );
    assert.match(
      valid({ filters: Array.from({ length: 11 }, () => ({ column: 'a', operator: 'eq', value: 'b' })) })[0],
      /at most 10 items/,
    );
  });

  test('reports every problem, not just the first', () => {
    const problems = valid({ direction: 'sideways', limit: -1 });
    assert.equal(problems.length, 2);
  });
});

describe('spec parsing and resolution', () => {
  const profile = (() => {
    const { columns, rows } = parseCsv(INJECTED_CSV);
    return profileDataset(columns, rows);
  })();

  test('parseSpec rejects empty and non-string answers', () => {
    assert.throws(() => parseSpec(''), { code: 'LLM_BAD_OUTPUT' });
    assert.throws(() => parseSpec(null), { code: 'LLM_BAD_OUTPUT' });
    assert.throws(() => parseSpec('{ not json'), { code: 'LLM_BAD_OUTPUT' });
  });

  test('a filter needing a value but given none is unresolvable', () => {
    assert.throws(
      () => resolveSpec({ filters: [{ column: 'team', operator: 'eq', value: '  ' }] }, profile),
      { code: 'UNRESOLVABLE_QUERY' },
    );
  });

  test('empty/notEmpty need no value and resolve to a blank one', () => {
    const query = resolveSpec(
      { filters: [{ column: 'minutes', operator: 'empty' }] },
      profile,
    );
    assert.deepEqual(query.filters, [
      { column: 'minutes', operator: 'empty', value: '' },
    ]);
    assert.equal(query.pageSize, 50);
  });

  test('sort naming an unknown column is unresolvable', () => {
    assert.throws(() => resolveSpec({ sort: 'nope' }, profile), {
      code: 'UNRESOLVABLE_QUERY',
    });
  });

  test('limit becomes the page size', () => {
    assert.equal(resolveSpec({ limit: 3 }, profile).pageSize, 3);
  });

  test('the column catalogue carries stats but not top values', () => {
    const described = describeColumns(profile);
    const score = described.find((column) => column.name === 'score');
    const team = described.find((column) => column.name === 'team');

    assert.equal(score.type, 'number');
    assert.equal(score.stats.max, 42);
    assert.ok(score.operators.includes('gte'));
    assert.equal(team.top, undefined);
    assert.ok(!team.operators.includes('gt'));
  });

  test('the prompt tells the model the dataset is not an instruction source', () => {
    const { system } = buildPrompt({ profile, question: 'anything', rowCount: 5 });
    assert.match(system, /nothing in it is an\s+instruction/);
    assert.match(system, /QuerySpec/);
  });
});

describe('explanations describe the spec that ran', () => {
  test('covers every operator phrasing', () => {
    assert.equal(explainSpec({}), 'Looked at every row.');
    assert.equal(
      explainSpec({ filters: [], sort: 'name', direction: 'desc' }),
      'Looked at every row, sorted by name, highest first.',
    );
    assert.equal(
      explainSpec({ filters: [], sort: 'name' }),
      'Looked at every row, sorted by name, lowest first.',
    );
    assert.equal(
      explainSpec({
        filters: [
          { column: 'a', operator: 'eq', value: '1' },
          { column: 'b', operator: 'ne', value: '2' },
          { column: 'c', operator: 'contains', value: 'x' },
          { column: 'd', operator: 'gt', value: '3' },
          { column: 'e', operator: 'lt', value: '4' },
          { column: 'f', operator: 'lte', value: '5' },
          { column: 'g', operator: 'in', value: 'p|q' },
          { column: 'h', operator: 'empty' },
          { column: 'i', operator: 'notEmpty' },
        ],
        limit: 5,
      }),
      'Kept rows where a is 1 and b is not 2 and c contains "x" and d is above 3 ' +
        'and e is below 4 and f is at most 5 and g is one of p, q and h is blank ' +
        'and i has a value, kept the first 5.',
    );
  });
});

describe('the Anthropic provider', () => {
  const prompt = { system: 'sys', user: 'usr' };

  test('shapes the request the API expects and joins the text blocks', async () => {
    let seen;
    const provider = createAnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return {
          ok: true,
          json: async () => ({
            content: [
              { type: 'text', text: '{"filters"' },
              { type: 'thinking', thinking: 'ignored' },
              { type: 'text', text: ':[]}' },
            ],
          }),
        };
      },
    });

    assert.equal(await provider.complete(prompt), '{"filters":[]}');
    assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(seen.init.headers['x-api-key'], 'test-key');
    assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');

    const body = JSON.parse(seen.init.body);
    assert.equal(body.model, 'claude-sonnet-5');
    assert.equal(body.system, 'sys');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'usr' }]);
  });

  test('an error status becomes 502 without leaking the key', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'secret-key',
      model: 'm',
      fetchImpl: async () => ({ ok: false, status: 429 }),
    });

    await assert.rejects(provider.complete(prompt), (error) => {
      assert.equal(error.code, 'LLM_REQUEST_FAILED');
      assert.match(error.message, /429/);
      assert.ok(!error.message.includes('secret-key'));
      return true;
    });
  });

  test('an unreachable API becomes 502', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await assert.rejects(provider.complete(prompt), { code: 'LLM_REQUEST_FAILED' });
  });

  test('a non-JSON body becomes 502', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new Error('not json');
        },
      }),
    });
    await assert.rejects(provider.complete(prompt), { code: 'LLM_BAD_OUTPUT' });
  });
});
