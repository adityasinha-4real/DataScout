import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, toCsv } from '../src/csv/parse.js';

test('parses a plain CSV into columns and rows', () => {
  const result = parseCsv('a,b\n1,2\n3,4\n');
  assert.deepEqual(result.columns, ['a', 'b']);
  assert.deepEqual(result.rows, [
    ['1', '2'],
    ['3', '4'],
  ]);
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.warnings, []);
});

test('honours RFC 4180 quoting: commas, newlines and doubled quotes', () => {
  const csv = 'name,note\n"Doe, Jane","said ""hi""\nthen left"\n';
  const result = parseCsv(csv);
  assert.deepEqual(result.rows, [['Doe, Jane', 'said "hi"\nthen left']]);
});

test('accepts CRLF line endings and a UTF-8 BOM', () => {
  const result = parseCsv('﻿a,b\r\n1,2\r\n');
  assert.deepEqual(result.columns, ['a', 'b']);
  assert.deepEqual(result.rows, [['1', '2']]);
});

test('parses a final row that is not newline-terminated', () => {
  const result = parseCsv('a,b\n1,2');
  assert.equal(result.rowCount, 1);
  assert.deepEqual(result.rows[0], ['1', '2']);
});

test('pads short rows and warns instead of dropping them', () => {
  const result = parseCsv('a,b,c\n1,2\n');
  assert.deepEqual(result.rows, [['1', '2', '']]);
  assert.equal(result.warnings[0].code, 'MISSING_FIELDS');
});

test('truncates over-long rows and warns', () => {
  const result = parseCsv('a,b\n1,2,3\n');
  assert.deepEqual(result.rows, [['1', '2']]);
  assert.equal(result.warnings[0].code, 'EXTRA_FIELDS');
});

test('makes header names unique and fills in blank ones', () => {
  const result = parseCsv('score, ,score,score\n1,2,3,4\n');
  assert.deepEqual(result.columns, ['score', 'column_2', 'score_2', 'score_3']);
});

test('a header-only file is valid and has zero rows', () => {
  const result = parseCsv('a,b,c\n');
  assert.equal(result.rowCount, 0);
  assert.deepEqual(result.columns, ['a', 'b', 'c']);
});

test('stops at maxRows and records a ROW_LIMIT warning', () => {
  const result = parseCsv('a\n1\n2\n3\n', { maxRows: 2 });
  assert.equal(result.rowCount, 2);
  assert.equal(result.warnings.at(-1).code, 'ROW_LIMIT');
});

for (const [label, input] of [
  ['empty string', ''],
  ['whitespace only', '   \n\n  '],
  ['not a string', null],
]) {
  test(`rejects ${label} with EMPTY_CSV`, () => {
    assert.throws(() => parseCsv(input), (err) => {
      assert.equal(err.code, 'EMPTY_CSV');
      assert.equal(err.status, 400);
      return true;
    });
  });
}

test('toCsv quotes only what needs quoting and round-trips', () => {
  const columns = ['a', 'b'];
  const rows = [['plain', 'has,comma'], ['has "quote"', 'line\nbreak']];
  const serialized = toCsv(columns, rows);
  assert.match(serialized, /^a,b\r\n/);
  assert.deepEqual(parseCsv(serialized).rows, rows);
});

test('toCsv renders null and undefined cells as empty strings', () => {
  assert.equal(toCsv(['a', 'b'], [[null, undefined]]), 'a,b\r\n,');
});
