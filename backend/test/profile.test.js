import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from '../src/csv/parse.js';
import { profileDataset, parseNumber, isBlank } from '../src/csv/profile.js';
import { SAMPLE_CSV } from './helpers.js';

function profileOf(csv) {
  const { columns, rows } = parseCsv(csv);
  const profile = profileDataset(columns, rows);
  return Object.fromEntries(profile.columns.map((c) => [c.name, c]));
}

test('infers a numeric column and computes its statistics', () => {
  const { score } = profileOf(SAMPLE_CSV);
  assert.equal(score.type, 'number');
  assert.equal(score.stats.min, 15);
  assert.equal(score.stats.max, 42);
  assert.equal(score.stats.median, 37);
  assert.equal(score.stats.sum, 164);
  assert.equal(score.stats.mean, 32.8);
  // Population standard deviation of [15, 28, 37, 42, 42].
  assert.ok(Math.abs(score.stats.stddev - 10.264502) < 1e-5);
});

test('counts missing cells and distinct values', () => {
  const columns = profileOf(SAMPLE_CSV);
  assert.equal(columns.minutes.missing, 1);
  assert.equal(columns.minutes.count, 5);
  assert.equal(columns.score.unique, 4);
  assert.equal(columns.team.unique, 3);
});

test('infers string, date and boolean columns', () => {
  const columns = profileOf(
    'name,when,active\nAda,2021-03-01,true\nGrace,2020-07-14,false\n',
  );
  assert.equal(columns.name.type, 'string');
  assert.equal(columns.when.type, 'date');
  assert.equal(columns.active.type, 'boolean');
});

test('a column mixing numbers and words is a string column', () => {
  const columns = profileOf('mixed\n1\ntwo\n3\n');
  assert.equal(columns.mixed.type, 'string');
  assert.equal(columns.mixed.stats, undefined);
  assert.deepEqual(columns.mixed.top[0], { value: '1', count: 1 });
});

test('an entirely blank column is typed "empty" and fully missing', () => {
  const columns = profileOf('a,blank\n1,\n2,   \n');
  assert.equal(columns.blank.type, 'empty');
  assert.equal(columns.blank.missing, 2);
  assert.equal(columns.blank.unique, 0);
  assert.equal(columns.blank.top, undefined);
});

test('string columns report their most frequent values first', () => {
  const columns = profileOf('team\nBlue\nRed\nBlue\nGreen\nBlue\nRed\n');
  assert.deepEqual(columns.team.top.slice(0, 2), [
    { value: 'Blue', count: 3 },
    { value: 'Red', count: 2 },
  ]);
});

test('profiling an empty row set still describes every column', () => {
  const profile = profileDataset(['a', 'b'], []);
  assert.equal(profile.rowCount, 0);
  assert.equal(profile.columns.length, 2);
  assert.equal(profile.columns[0].type, 'empty');
});

test('parseNumber accepts formatted numbers and rejects text', () => {
  assert.equal(parseNumber('1,234.5'), 1234.5);
  assert.equal(parseNumber('$42'), 42);
  assert.equal(parseNumber('12%'), 12);
  assert.equal(parseNumber('-3.5e2'), -350);
  assert.equal(parseNumber('twelve'), null);
  assert.equal(parseNumber('12abc'), null);
  assert.equal(parseNumber(''), null);
});

test('isBlank treats whitespace, null and undefined as missing', () => {
  assert.equal(isBlank('  '), true);
  assert.equal(isBlank(null), true);
  assert.equal(isBlank(undefined), true);
  assert.equal(isBlank('0'), false);
});
