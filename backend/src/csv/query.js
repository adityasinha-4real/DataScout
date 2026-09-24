import { badRequest } from '../errors.js';
import { isBlank, parseNumber } from './profile.js';

/**
 * In-memory query engine over a parsed dataset: filter, sort, dense-rank and
 * paginate. Kept free of Express and SQL so it can be unit tested directly.
 */

export const OPERATORS = new Set([
  'eq',
  'ne',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'empty',
  'notEmpty',
]);

function columnIndex(columns, name) {
  const index = columns.indexOf(name);
  if (index === -1) {
    throw badRequest(
      'UNKNOWN_COLUMN',
      `Unknown column "${name}". Available columns: ${columns.join(', ')}.`,
    );
  }
  return index;
}

/**
 * Compare two raw cells. Numeric when both sides look numeric, otherwise a
 * case-insensitive string compare, so sorting a "score" column behaves like
 * numbers rather than lexicographically ("10" before "9").
 */
export function compareCells(a, b) {
  const aBlank = isBlank(a);
  const bBlank = isBlank(b);
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1; // blanks sink to the bottom regardless of direction
  if (bBlank) return -1;

  const na = parseNumber(a);
  const nb = parseNumber(b);
  if (na !== null && nb !== null) return na - nb;

  return String(a).localeCompare(String(b), 'en', { sensitivity: 'base' });
}

/**
 * Direction-aware ordering. Blanks are held out of the reversal so they stay
 * at the bottom whether you sort ascending or descending — a row with no
 * value is never "the top result".
 */
function orderBy(a, b, direction) {
  const aBlank = isBlank(a);
  const bBlank = isBlank(b);
  if (aBlank || bBlank) {
    if (aBlank && bBlank) return 0;
    return aBlank ? 1 : -1;
  }
  return direction * compareCells(a, b);
}

function matches(cell, operator, operand) {
  const text = isBlank(cell) ? '' : String(cell).trim();

  switch (operator) {
    case 'empty':
      return text === '';
    case 'notEmpty':
      return text !== '';
    case 'eq':
      return text.toLowerCase() === String(operand).trim().toLowerCase();
    case 'ne':
      return text.toLowerCase() !== String(operand).trim().toLowerCase();
    case 'contains':
      return text.toLowerCase().includes(String(operand).trim().toLowerCase());
    case 'in':
      return String(operand)
        .split('|')
        .map((v) => v.trim().toLowerCase())
        .includes(text.toLowerCase());
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (text === '') return false;
      const sign = compareCells(text, operand);
      if (operator === 'gt') return sign > 0;
      if (operator === 'gte') return sign >= 0;
      if (operator === 'lt') return sign < 0;
      return sign <= 0;
    }
    default:
      throw badRequest(
        'UNKNOWN_OPERATOR',
        `Unknown filter operator "${operator}". Supported: ${[...OPERATORS].join(', ')}.`,
      );
  }
}

/**
 * Filters are given as "column:operator:value" strings so they survive a URL
 * query string without needing a nested encoding.
 */
export function parseFilter(spec) {
  const parts = String(spec).split(':');
  if (parts.length < 2) {
    throw badRequest(
      'INVALID_FILTER',
      `Filter "${spec}" must look like column:operator[:value].`,
    );
  }
  const [column, operator, ...rest] = parts;
  if (!OPERATORS.has(operator)) {
    throw badRequest(
      'UNKNOWN_OPERATOR',
      `Unknown filter operator "${operator}". Supported: ${[...OPERATORS].join(', ')}.`,
    );
  }
  const value = rest.join(':');
  if (!['empty', 'notEmpty'].includes(operator) && value === '') {
    throw badRequest(
      'INVALID_FILTER',
      `Filter operator "${operator}" needs a value, as in ${column}:${operator}:something.`,
    );
  }
  return { column, operator, value };
}

/**
 * @param {{columns: string[], rows: string[][]}} dataset
 * @param {{filters?: string[], sort?: string, direction?: string,
 *          rankBy?: string, page?: number, pageSize?: number}} query
 */
export function queryRows(dataset, query = {}) {
  const { columns, rows } = dataset;
  let result = rows;

  for (const spec of query.filters ?? []) {
    const { column, operator, value } = parseFilter(spec);
    const index = columnIndex(columns, column);
    result = result.filter((row) => matches(row[index], operator, value));
  }

  if (query.rankBy) {
    const index = columnIndex(columns, query.rankBy);
    // Rank is always "best first" on the numeric value, with dense ranking so
    // tied rows share a rank and the next rank is not skipped.
    result = [...result].sort((a, b) => orderBy(a[index], b[index], -1));
    let rank = 0;
    let previous;
    result = result.map((row) => {
      const value = row[index];
      if (previous === undefined || compareCells(value, previous) !== 0) {
        rank += 1;
        previous = value;
      }
      return { row, rank };
    });
  } else if (query.sort) {
    const index = columnIndex(columns, query.sort);
    const direction = query.direction === 'desc' ? -1 : 1;
    result = [...result]
      .sort((a, b) => orderBy(a[index], b[index], direction))
      .map((row) => ({ row, rank: null }));
  } else {
    result = result.map((row) => ({ row, rank: null }));
  }

  const total = result.length;
  // Export needs every matching row, so it opts out of the page-size cap.
  if (query.paginate === false) {
    return {
      columns,
      rows: result,
      total,
      page: 1,
      pageSize: total,
      pageCount: 1,
    };
  }
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 1000);
  const pageCount = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(Math.max(query.page ?? 1, 1), pageCount);
  const start = (page - 1) * pageSize;

  return {
    columns,
    rows: result.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    pageCount,
  };
}
