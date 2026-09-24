import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from '../src/csv/parse.js';
import { queryRows, parseFilter, compareCells } from '../src/csv/query.js';
import { SAMPLE_CSV } from './helpers.js';

const dataset = parseCsv(SAMPLE_CSV);
const names = (result) => result.rows.map((entry) => entry.row[0]);

test('returns every row when no query is given', () => {
  const result = queryRows(dataset);
  assert.equal(result.total, 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageCount, 1);
});

test('filters by equality, case-insensitively', () => {
  assert.deepEqual(names(queryRows(dataset, { filters: ['team:eq:blue'] })), [
    'Ada',
    'Linus',
  ]);
});

test('supports contains, in, ne and the comparison operators', () => {
  assert.deepEqual(names(queryRows(dataset, { filters: ['name:contains:a'] })), [
    'Ada',
    'Grace',
    'Barbara',
    'Alan',
  ]);
  assert.equal(queryRows(dataset, { filters: ['team:in:Red|Green'] }).total, 3);
  assert.equal(queryRows(dataset, { filters: ['team:ne:Blue'] }).total, 3);
  assert.deepEqual(names(queryRows(dataset, { filters: ['score:gt:37'] })), [
    'Ada',
    'Linus',
  ]);
  assert.equal(queryRows(dataset, { filters: ['score:gte:37'] }).total, 3);
  assert.equal(queryRows(dataset, { filters: ['score:lt:28'] }).total, 1);
  assert.equal(queryRows(dataset, { filters: ['score:lte:28'] }).total, 2);
});

test('empty and notEmpty select on missing cells', () => {
  assert.deepEqual(names(queryRows(dataset, { filters: ['minutes:empty'] })), [
    'Barbara',
  ]);
  assert.equal(queryRows(dataset, { filters: ['minutes:notEmpty'] }).total, 4);
});

test('comparison filters never match a blank cell', () => {
  assert.equal(queryRows(dataset, { filters: ['minutes:gt:0'] }).total, 4);
});

test('multiple filters combine with AND', () => {
  const result = queryRows(dataset, {
    filters: ['team:eq:Blue', 'minutes:gt:70'],
  });
  assert.deepEqual(names(result), ['Ada']);
});

test('sorts numeric columns by value, not lexicographically', () => {
  const result = queryRows(dataset, { sort: 'score', direction: 'desc' });
  assert.deepEqual(
    result.rows.map((entry) => entry.row[2]),
    ['42', '42', '37', '28', '15'],
  );
});

test('sorting ascending puts blanks last in both directions', () => {
  const asc = queryRows(dataset, { sort: 'minutes', direction: 'asc' });
  const desc = queryRows(dataset, { sort: 'minutes', direction: 'desc' });
  assert.equal(asc.rows.at(-1).row[0], 'Barbara');
  assert.equal(desc.rows.at(-1).row[0], 'Barbara');
});

test('ranking is dense: ties share a rank and the next rank is not skipped', () => {
  const result = queryRows(dataset, { rankBy: 'score' });
  assert.deepEqual(
    result.rows.map((entry) => [entry.row[0], entry.rank]),
    [
      ['Ada', 1],
      ['Linus', 1],
      ['Grace', 2],
      ['Alan', 3],
      ['Barbara', 4],
    ],
  );
});

test('ranking applies after filtering', () => {
  const result = queryRows(dataset, {
    filters: ['team:eq:Red'],
    rankBy: 'score',
  });
  assert.deepEqual(
    result.rows.map((entry) => [entry.row[0], entry.rank]),
    [
      ['Grace', 1],
      ['Alan', 2],
    ],
  );
});

test('paginates and clamps an out-of-range page to the last one', () => {
  const page2 = queryRows(dataset, { sort: 'name', page: 2, pageSize: 2 });
  assert.equal(page2.pageCount, 3);
  assert.equal(page2.rows.length, 2);

  const beyond = queryRows(dataset, { sort: 'name', page: 99, pageSize: 2 });
  assert.equal(beyond.page, 3);
  assert.equal(beyond.rows.length, 1);
});

test('paginate:false returns every matching row', () => {
  const result = queryRows(dataset, { paginate: false, pageSize: 1 });
  assert.equal(result.rows.length, 5);
  assert.equal(result.pageCount, 1);
});

test('an unknown column is a 400 UNKNOWN_COLUMN for filter, sort and rank', () => {
  for (const query of [
    { filters: ['nope:eq:1'] },
    { sort: 'nope' },
    { rankBy: 'nope' },
  ]) {
    assert.throws(() => queryRows(dataset, query), (err) => {
      assert.equal(err.code, 'UNKNOWN_COLUMN');
      assert.equal(err.status, 400);
      return true;
    });
  }
});

test('malformed filter specs are rejected with a usable message', () => {
  assert.throws(() => parseFilter('justacolumn'), /INVALID_FILTER|column:operator/);
  assert.throws(() => parseFilter('a:wat:1'), (err) => {
    assert.equal(err.code, 'UNKNOWN_OPERATOR');
    return true;
  });
  assert.throws(() => parseFilter('a:eq:'), (err) => {
    assert.equal(err.code, 'INVALID_FILTER');
    return true;
  });
});

test('a filter value may itself contain colons', () => {
  const parsed = parseFilter('when:eq:2021-03-01T10:30:00');
  assert.equal(parsed.value, '2021-03-01T10:30:00');
});

test('compareCells orders numbers numerically and blanks last', () => {
  assert.ok(compareCells('9', '10') < 0);
  assert.ok(compareCells('b', 'a') > 0);
  assert.equal(compareCells('', ''), 0);
  assert.ok(compareCells('', 'a') > 0);
  assert.ok(compareCells('a', '') < 0);
});
