import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { api, registerUser } from './helpers.js';
import { specProvider, startServerWith } from './harness.js';
import {
  MIN_VALUES,
  detectAnomalies,
  detectOutliers,
  quantile,
} from '../src/csv/anomalies.js';
import { profileDataset } from '../src/csv/profile.js';
import { parseCsv } from '../src/csv/parse.js';
import { queryRows } from '../src/csv/query.js';
import { describeColumns } from '../src/llm/querySpec.js';

/** The criterion's fixture: one obvious spike at 0-based data row 7. */
const SPIKE_CSV = [
  'label,value,note',
  'a,10,x',
  'b,11,x',
  'c,12,x',
  'd,11,x',
  'e,10,x',
  'f,12,x',
  'g,11,x',
  'h,95,x',
].join('\n');

/** Every degenerate shape in one upload, plus a well-behaved column. */
const EDGE_CSV = [
  'constant,sparse,gappy,word,flag,day,blank',
  '7,1,10,alpha,true,2024-01-01,',
  '7,,,beta,false,2024-01-02,',
  '7,2,11,gamma,true,2024-01-03,',
  '7,,12,delta,false,2024-01-04,',
  '7,,,epsilon,true,2024-01-05,',
  '7,3,11,zeta,false,2024-01-06,',
  '7,,10,eta,true,2024-01-07,',
].join('\n');

const points = (values) => values.map((value, row) => ({ row, value }));

async function upload(baseUrl, token, csv) {
  const { status, body } = await api(baseUrl, '/api/datasets?name=Spike', {
    method: 'POST',
    token,
    csv,
  });
  assert.equal(status, 201);
  return body.dataset.id;
}

/** True if any number anywhere in the payload is NaN or ±Infinity, or null. */
function hasNonFinite(value) {
  if (value === null) return true;
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonFinite);
  if (typeof value === 'object') return Object.values(value).some(hasNonFinite);
  return false;
}

describe('outlier rules', () => {
  test('quartiles interpolate linearly between order statistics', () => {
    const sorted = [10, 10, 11, 11, 11, 12, 12, 95];
    assert.equal(quantile(sorted, 0.25), 10.75);
    assert.equal(quantile(sorted, 0.5), 11);
    assert.equal(quantile(sorted, 0.75), 12);
    assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  });

  test('the spike fixture flags exactly row 7 by both rules', () => {
    const result = detectOutliers(points([10, 11, 12, 11, 10, 12, 11, 95]));
    assert.equal(result.insufficientData, false);
    assert.deepEqual(result.flagged, [
      { row: 7, value: 95, rules: ['iqr', 'robustZ'] },
    ]);
    assert.deepEqual(result.stats, {
      q1: 10.75,
      q3: 12,
      iqr: 1.25,
      lowerFence: 8.875,
      upperFence: 13.875,
      median: 11,
      mad: 1,
    });
  });

  test('flags low outliers as well as high ones', () => {
    const result = detectOutliers(points([50, 51, 49, 50, 52, 48, 50, -40]));
    assert.deepEqual(
      result.flagged.map((f) => [f.row, f.value]),
      [[7, -40]],
    );
  });

  test('reports only the rules that fired', () => {
    // Median 5, MAD 1 → robust z of 12 is 7/1.4826 ≈ 4.72, over 3.5. The
    // quartiles are 5 and 7, so the upper IQR fence is 10: IQR fires too.
    // 9 sits under the fence and has robust z 4/1.4826 ≈ 2.70: not flagged.
    const both = detectOutliers(points([4, 4, 5, 5, 5, 6, 7, 9, 12]));
    assert.deepEqual(both.flagged, [{ row: 8, value: 12, rules: ['iqr', 'robustZ'] }]);

    // Q1 10, Q3 25, so the upper fence is 47.5 and IQR flags nothing. Median
    // 10, MAD 5: each 40 has robust z 30/7.413 ≈ 4.05, so only that rule fires.
    const zOnly = detectOutliers(points([0, 0, 10, 10, 10, 10, 10, 30, 40, 40]));
    assert.deepEqual(zOnly.flagged, [
      { row: 8, value: 40, rules: ['robustZ'] },
      { row: 9, value: 40, rules: ['robustZ'] },
    ]);

    // And the reverse: Q1 3.75, Q3 9.25, so 20 clears the fence of 17.5, but
    // with median 6.5 and MAD 3 its robust z is 13.5/4.4478 ≈ 3.04 < 3.5.
    const iqrOnly = detectOutliers(points([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 20]));
    assert.deepEqual(iqrOnly.flagged, [{ row: 11, value: 20, rules: ['iqr'] }]);
  });

  test('a constant column flags nothing and every stat stays finite', () => {
    const result = detectOutliers(points([7, 7, 7, 7, 7, 7]));
    assert.deepEqual(result.flagged, []);
    assert.equal(result.stats.mad, 0);
    assert.equal(result.stats.iqr, 0);
    assert.equal(hasNonFinite(result), false);
  });

  test('MAD of zero switches the robust-z rule off instead of dividing by it', () => {
    // More than half the values equal the median, so MAD = 0. The IQR rule
    // still catches 9; robust z must not appear, and nothing is Infinity.
    const result = detectOutliers(points([5, 5, 5, 5, 5, 5, 9]));
    assert.equal(result.stats.mad, 0);
    assert.deepEqual(result.flagged, [{ row: 6, value: 9, rules: ['iqr'] }]);
    assert.equal(hasNonFinite(result), false);
  });

  test(`fewer than ${MIN_VALUES} values is insufficient data, never a flag`, () => {
    for (const values of [[], [1], [1, 1000], [1, 2, 1000000]]) {
      const result = detectOutliers(points(values));
      assert.deepEqual(result, { insufficientData: true, flagged: [] });
    }
    assert.equal(detectOutliers(points([1, 2, 3, 4])).insufficientData, false);
  });
});

describe('GET /api/datasets/:id/anomalies', () => {
  test('flags exactly one row on the spike fixture', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const owner = await registerUser(baseUrl);
    const id = await upload(baseUrl, owner.token, SPIKE_CSV);

    const { status, body } = await api(baseUrl, `/api/datasets/${id}/anomalies`, {
      token: owner.token,
    });

    assert.equal(status, 200);
    assert.equal(body.datasetId, id);
    assert.deepEqual(
      body.columns.map((c) => c.column),
      ['value'],
      'string columns are omitted',
    );
    assert.deepEqual(body.columns[0].flagged, [
      { row: 7, value: 95, rules: ['iqr', 'robustZ'] },
    ]);
    assert.equal(body.columns[0].insufficientData, false);
  });

  test('degenerate columns: constant, sparse, gappy and non-numeric', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const owner = await registerUser(baseUrl);
    const id = await upload(baseUrl, owner.token, EDGE_CSV);

    const { status, body } = await api(baseUrl, `/api/datasets/${id}/anomalies`, {
      token: owner.token,
    });
    assert.equal(status, 200);

    // string, boolean, date and empty columns are left out entirely.
    const byName = Object.fromEntries(body.columns.map((c) => [c.column, c]));
    assert.deepEqual(Object.keys(byName).sort(), ['constant', 'gappy', 'sparse']);

    assert.deepEqual(byName.constant.flagged, []);
    assert.equal(byName.constant.insufficientData, false);

    // Three values after dropping four blanks: not enough to judge.
    assert.equal(byName.sparse.insufficientData, true);
    assert.deepEqual(byName.sparse.flagged, []);

    // Blanks are skipped, not read as 0. Were they zeros, 10–12 would sit far
    // above a median near 0 and get flagged; ignored, nothing is unusual.
    assert.equal(byName.gappy.insufficientData, false);
    assert.deepEqual(byName.gappy.flagged, []);
    assert.equal(byName.gappy.stats.median, 11);

    assert.equal(hasNonFinite(body), false, 'no NaN, Infinity or null anywhere');
    assert.doesNotMatch(JSON.stringify(body), /NaN|Infinity|null/);
  });

  test("another user's dataset is 404, and no token is 401", async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const owner = await registerUser(baseUrl);
    const stranger = await registerUser(baseUrl);
    const id = await upload(baseUrl, owner.token, SPIKE_CSV);

    const foreign = await api(baseUrl, `/api/datasets/${id}/anomalies`, {
      token: stranger.token,
    });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error.code, 'NOT_FOUND');

    const anonymous = await api(baseUrl, `/api/datasets/${id}/anomalies`);
    assert.equal(anonymous.status, 401);
  });
});

describe('anomaliesOnly on /rows and /export', () => {
  test('narrows rows to flagged ones and carries their source index', async () => {
    const { baseUrl } = await startServerWith({ llm: null });
    const owner = await registerUser(baseUrl);
    const id = await upload(baseUrl, owner.token, SPIKE_CSV);

    const only = await api(
      baseUrl,
      `/api/datasets/${id}/rows?anomaliesOnly=true`,
      { token: owner.token },
    );
    assert.equal(only.status, 200);
    assert.equal(only.body.total, 1);
    assert.deepEqual(only.body.rows, [
      { row: ['h', '95', 'x'], rank: null, index: 7 },
    ]);

    const all = await api(
      baseUrl,
      `/api/datasets/${id}/rows?anomaliesOnly=false`,
      { token: owner.token },
    );
    assert.equal(all.body.total, 8);
    assert.deepEqual(
      all.body.rows.map((entry) => entry.index),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );

    const exported = await api(
      baseUrl,
      `/api/datasets/${id}/export?anomaliesOnly=true`,
      { token: owner.token },
    );
    assert.equal(exported.status, 200);
    assert.deepEqual(parseCsv(exported.body).rows, [['h', '95', 'x']]);

    const invalid = await api(
      baseUrl,
      `/api/datasets/${id}/rows?anomaliesOnly=yes`,
      { token: owner.token },
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  });

  test('the source index survives sorting, ranking and filters', () => {
    const { columns, rows } = parseCsv(SPIKE_CSV);
    const ranked = queryRows({ columns, rows }, { rankBy: 'value' });
    assert.deepEqual(ranked.rows[0], { row: ['h', '95', 'x'], rank: 1, index: 7 });

    const sorted = queryRows(
      { columns, rows },
      { sort: 'value', direction: 'asc', filters: ['value:gte:12'] },
    );
    assert.deepEqual(
      sorted.rows.map((entry) => entry.index),
      [2, 5, 7],
    );

    const restricted = queryRows(
      { columns, rows },
      { onlyRows: new Set([0, 7]), filters: ['value:lt:50'] },
    );
    assert.deepEqual(
      restricted.rows.map((entry) => entry.index),
      [0],
    );
  });
});

describe('anomalies never reach the model', () => {
  test('the prompt carries the AC-T4 stat allowlist and no anomaly data', async () => {
    const llm = specProvider({ filters: [] });
    const { baseUrl } = await startServerWith({ llm });
    const owner = await registerUser(baseUrl);
    const id = await upload(baseUrl, owner.token, SPIKE_CSV);

    // Compute anomalies first, so a leak through any shared cache would show.
    await api(baseUrl, `/api/datasets/${id}/anomalies`, { token: owner.token });
    const { status } = await api(baseUrl, `/api/datasets/${id}/ask`, {
      method: 'POST',
      token: owner.token,
      json: { question: 'anything unusual?' },
    });
    assert.equal(status, 200);

    const sent = `${llm.prompts[0].system}\n${llm.prompts[0].user}`;
    for (const marker of [
      'flagged',
      'rules',
      'robustZ',
      'iqr',
      'lowerFence',
      'upperFence',
      'insufficientData',
      'anomal',
    ]) {
      assert.equal(sent.includes(marker), false, `prompt leaked "${marker}"`);
    }

    const payload = JSON.parse(llm.prompts[0].user);
    const value = payload.columns.find((c) => c.name === 'value');
    assert.deepEqual(Object.keys(value.stats).sort(), [
      'max',
      'mean',
      'median',
      'min',
      'stddev',
      'sum',
    ]);
  });

  test('extra fields attached to a profile are not forwarded', () => {
    const { columns, rows } = parseCsv(SPIKE_CSV);
    const profile = profileDataset(columns, rows);
    const anomalies = detectAnomalies(rows, profile);
    // Simulate a future change that hangs anomaly data off the profile.
    profile.columns[1].stats.flagged = anomalies[0].flagged;
    profile.columns[1].anomalies = anomalies[0];

    const described = describeColumns(profile);
    const text = JSON.stringify(described);
    assert.equal(text.includes('flagged'), false);
    assert.equal(text.includes('anomalies'), false);
    assert.equal(text.includes('robustZ'), false);
  });
});
