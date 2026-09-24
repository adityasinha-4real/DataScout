import test from 'node:test';
import assert from 'node:assert/strict';

import { api, registerUser, startTestServer, SAMPLE_CSV } from './helpers.js';
import { parseCsv } from '../src/csv/parse.js';

const { baseUrl } = await startTestServer();
const owner = await registerUser(baseUrl);

async function upload(token, csv = SAMPLE_CSV, name = 'Players') {
  return api(baseUrl, `/api/datasets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    token,
    csv,
  });
}

test('uploading a CSV returns 201 with the parsed shape', async () => {
  const { status, body } = await upload(owner.token);
  assert.equal(status, 201);
  assert.equal(body.dataset.rowCount, 5);
  assert.deepEqual(body.dataset.columns, [
    'name',
    'team',
    'score',
    'minutes',
    'joined',
  ]);
  assert.equal(body.dataset.name, 'Players');
  assert.ok(body.dataset.id);
});

test('an upload with ragged rows still succeeds and reports warnings', async () => {
  const { status, body } = await upload(owner.token, 'a,b,c\n1,2\n1,2,3,4\n', 'Ragged');
  assert.equal(status, 201);
  assert.equal(body.dataset.rowCount, 2);
  assert.deepEqual(
    body.dataset.warnings.map((w) => w.code),
    ['MISSING_FIELDS', 'EXTRA_FIELDS'],
  );
});

test('an empty upload is rejected with 400 EMPTY_CSV', async () => {
  const { status, body } = await upload(owner.token, '   ', 'Empty');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'EMPTY_CSV');
});

test('uploading without a token is 401 and stores nothing', async () => {
  const before = await api(baseUrl, '/api/datasets', { token: owner.token });
  const { status } = await api(baseUrl, '/api/datasets', {
    method: 'POST',
    csv: SAMPLE_CSV,
  });
  const after = await api(baseUrl, '/api/datasets', { token: owner.token });

  assert.equal(status, 401);
  assert.equal(after.body.datasets.length, before.body.datasets.length);
});

test('a body sent as JSON rather than CSV is rejected with 400', async () => {
  const { status, body } = await api(baseUrl, '/api/datasets', {
    method: 'POST',
    token: owner.token,
    json: { rows: [] },
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'UNSUPPORTED_CONTENT_TYPE');
});

test('an upload over MAX_UPLOAD_BYTES is rejected with 413', async () => {
  const small = await startTestServer({ MAX_UPLOAD_BYTES: '64' });
  const user = await registerUser(small.baseUrl);
  const { status, body } = await api(small.baseUrl, '/api/datasets', {
    method: 'POST',
    token: user.token,
    csv: `a,b\n${'x'.repeat(500)},y\n`,
  });

  assert.equal(status, 413);
  assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('listing returns only the caller’s own datasets, newest first', async () => {
  const stranger = await registerUser(baseUrl);
  await upload(stranger.token, 'x\n1\n', 'Strangers data');

  const mine = await api(baseUrl, '/api/datasets', { token: owner.token });
  const theirs = await api(baseUrl, '/api/datasets', { token: stranger.token });

  assert.ok(mine.body.datasets.length >= 2);
  assert.equal(theirs.body.datasets.length, 1);
  assert.ok(!mine.body.datasets.some((d) => d.name === 'Strangers data'));
});

test('another user’s dataset id reads as 404, not 403', async () => {
  const stranger = await registerUser(baseUrl);
  const created = await upload(owner.token, SAMPLE_CSV, 'Private');

  for (const path of ['', '/profile', '/rows', '/export']) {
    const { status, body } = await api(
      baseUrl,
      `/api/datasets/${created.body.dataset.id}${path}`,
      { token: stranger.token },
    );
    assert.equal(status, 404, `${path || '/'} should be 404`);
    assert.equal(body.error.code, 'NOT_FOUND');
  }
});

test('an unknown dataset id is 404', async () => {
  const { status } = await api(
    baseUrl,
    '/api/datasets/11111111-2222-3333-4444-555555555555',
    { token: owner.token },
  );
  assert.equal(status, 404);
});

test('GET /profile types every column and computes numeric stats', async () => {
  const created = await upload(owner.token, SAMPLE_CSV, 'Profiled');
  const { status, body } = await api(
    baseUrl,
    `/api/datasets/${created.body.dataset.id}/profile`,
    { token: owner.token },
  );

  assert.equal(status, 200);
  const byName = Object.fromEntries(
    body.profile.columns.map((c) => [c.name, c]),
  );
  assert.equal(byName.score.type, 'number');
  assert.equal(byName.score.stats.max, 42);
  assert.equal(byName.name.type, 'string');
  assert.equal(byName.minutes.missing, 1);
});

test('GET /rows filters, ranks and paginates', async () => {
  const created = await upload(owner.token, SAMPLE_CSV, 'Queried');
  const id = created.body.dataset.id;

  const filtered = await api(
    baseUrl,
    `/api/datasets/${id}/rows?filter=team:eq:Blue`,
    { token: owner.token },
  );
  assert.equal(filtered.body.total, 2);

  const ranked = await api(baseUrl, `/api/datasets/${id}/rows?rankBy=score`, {
    token: owner.token,
  });
  assert.deepEqual(
    ranked.body.rows.slice(0, 2).map((entry) => entry.rank),
    [1, 1],
  );

  const paged = await api(
    baseUrl,
    `/api/datasets/${id}/rows?sort=name&page=2&pageSize=2`,
    { token: owner.token },
  );
  assert.equal(paged.body.page, 2);
  assert.equal(paged.body.pageCount, 3);
  assert.equal(paged.body.rows.length, 2);

  const twoFilters = await api(
    baseUrl,
    `/api/datasets/${id}/rows?filter=team:eq:Blue&filter=minutes:gt:70`,
    { token: owner.token },
  );
  assert.equal(twoFilters.body.total, 1);
});

test('GET /rows rejects an unknown column with 400 UNKNOWN_COLUMN', async () => {
  const created = await upload(owner.token, SAMPLE_CSV, 'Bad query');
  const { status, body } = await api(
    baseUrl,
    `/api/datasets/${created.body.dataset.id}/rows?sort=nope`,
    { token: owner.token },
  );
  assert.equal(status, 400);
  assert.equal(body.error.code, 'UNKNOWN_COLUMN');
});

test('GET /rows rejects an invalid page size with 400', async () => {
  const created = await upload(owner.token, SAMPLE_CSV, 'Bad page');
  const { status, body } = await api(
    baseUrl,
    `/api/datasets/${created.body.dataset.id}/rows?pageSize=0`,
    { token: owner.token },
  );
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('export returns filtered CSV that parses back to the same rows', async () => {
  const created = await upload(owner.token, SAMPLE_CSV, 'Export me');
  const { status, body, headers } = await api(
    baseUrl,
    `/api/datasets/${created.body.dataset.id}/export?filter=team:eq:Blue&sort=name`,
    { token: owner.token },
  );

  assert.equal(status, 200);
  assert.match(headers.get('content-type'), /text\/csv/);
  assert.match(headers.get('content-disposition'), /attachment; filename="Export_me.csv"/);

  const round = parseCsv(body);
  assert.deepEqual(round.columns, created.body.dataset.columns);
  assert.deepEqual(
    round.rows.map((r) => r[0]),
    ['Ada', 'Linus'],
  );
});

test('export is not capped at one page', async () => {
  const rows = Array.from({ length: 1200 }, (_, i) => `row${i},${i}`).join('\n');
  const created = await upload(owner.token, `name,n\n${rows}\n`, 'Big');
  const { body } = await api(
    baseUrl,
    `/api/datasets/${created.body.dataset.id}/export`,
    { token: owner.token },
  );
  assert.equal(parseCsv(body).rowCount, 1200);
});

test('a dataset can be deleted and then reads as 404', async () => {
  const created = await upload(owner.token, SAMPLE_CSV, 'Doomed');
  const id = created.body.dataset.id;

  const deleted = await api(baseUrl, `/api/datasets/${id}`, {
    method: 'DELETE',
    token: owner.token,
  });
  assert.equal(deleted.status, 204);

  const after = await api(baseUrl, `/api/datasets/${id}`, { token: owner.token });
  assert.equal(after.status, 404);
});

test('an upload name longer than the limit is rejected with 400', async () => {
  const { status, body } = await upload(owner.token, SAMPLE_CSV, 'n'.repeat(200));
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('an upload with no name gets a dated default', async () => {
  const { status, body } = await api(baseUrl, '/api/datasets', {
    method: 'POST',
    token: owner.token,
    csv: 'a\n1\n',
  });
  assert.equal(status, 201);
  assert.match(body.dataset.name, /^Dataset \d{4}-\d{2}-\d{2}$/);
});
