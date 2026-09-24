/**
 * Column profiling: infer a type per column from its non-empty values and
 * summarise it. This is what turns an opaque upload into something the
 * dashboard can offer sensible filters and rankings for.
 */

const BOOLEAN_VALUES = new Set(['true', 'false', 'yes', 'no', '0', '1']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;

export function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/** Numbers may carry thousands separators, a currency prefix or a percent. */
export function parseNumber(value) {
  if (isBlank(value)) return null;
  const cleaned = String(value)
    .trim()
    .replace(/^[$£€]/, '')
    .replace(/%$/, '')
    .replaceAll(',', '');
  if (cleaned === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) {
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferType(values) {
  if (values.length === 0) return 'empty';
  let numbers = 0;
  let booleans = 0;
  let dates = 0;
  for (const value of values) {
    if (parseNumber(value) !== null) numbers += 1;
    const lower = String(value).trim().toLowerCase();
    if (BOOLEAN_VALUES.has(lower)) booleans += 1;
    if (ISO_DATE.test(String(value).trim()) && !Number.isNaN(Date.parse(value))) {
      dates += 1;
    }
  }
  // Booleans are checked first: "0"/"1" parse as numbers too, but a column of
  // nothing but 0/1/true/false is far more useful treated as a flag.
  if (booleans === values.length) return 'boolean';
  if (numbers === values.length) return 'number';
  if (dates === values.length) return 'date';
  return 'string';
}

function numericStats(values) {
  const numbers = values
    .map(parseNumber)
    .filter((n) => n !== null)
    .sort((a, b) => a - b);
  if (numbers.length === 0) return null;

  const sum = numbers.reduce((acc, n) => acc + n, 0);
  const mean = sum / numbers.length;
  const mid = Math.floor(numbers.length / 2);
  const median =
    numbers.length % 2 === 0
      ? (numbers[mid - 1] + numbers[mid]) / 2
      : numbers[mid];
  const variance =
    numbers.reduce((acc, n) => acc + (n - mean) ** 2, 0) / numbers.length;

  const round = (n) => Math.round(n * 1e6) / 1e6;
  return {
    min: numbers[0],
    max: numbers[numbers.length - 1],
    mean: round(mean),
    median: round(median),
    stddev: round(Math.sqrt(variance)),
    sum: round(sum),
  };
}

function topValues(values, limit = 5) {
  const counts = new Map();
  for (const value of values) {
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

/**
 * @param {string[]} columns
 * @param {string[][]} rows
 * @returns {{rowCount: number, columns: Array<object>}}
 */
export function profileDataset(columns, rows) {
  const profiles = columns.map((name, index) => {
    const all = rows.map((row) => row[index] ?? '');
    const present = all.filter((value) => !isBlank(value));
    const type = inferType(present);

    const profile = {
      name,
      index,
      type,
      count: all.length,
      missing: all.length - present.length,
      unique: new Set(present.map((v) => String(v).trim())).size,
    };
    if (type === 'number') {
      profile.stats = numericStats(present);
    } else if (type !== 'empty') {
      profile.top = topValues(present.map((v) => String(v).trim()));
    }
    return profile;
  });

  return { rowCount: rows.length, columns: profiles };
}
