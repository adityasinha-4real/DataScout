import { badRequest } from '../errors.js';

/**
 * RFC 4180 CSV reader.
 *
 * Handles quoted fields containing commas, newlines and doubled quotes,
 * mixed CRLF/LF line endings and a UTF-8 BOM. Ragged rows are repaired
 * rather than rejected: short rows are padded with empty strings, long rows
 * are truncated to the header width, and both are reported as warnings so
 * the caller can surface them without losing the rest of the file.
 */

const QUOTE = '"';
const DELIMITER = ',';

function splitRecords(text) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let sawAnyChar = false;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    sawAnyChar = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === QUOTE) {
        if (text[i + 1] === QUOTE) {
          field += QUOTE;
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      sawAnyChar = true;
      continue;
    }

    if (char === QUOTE && field === '') {
      inQuotes = true;
      sawAnyChar = true;
    } else if (char === DELIMITER) {
      endField();
      sawAnyChar = true;
    } else if (char === '\n') {
      endRecord();
    } else if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRecord();
    } else {
      field += char;
      sawAnyChar = true;
    }
  }

  // A file that does not end in a newline still has one final record.
  if (sawAnyChar || field !== '' || record.length > 0) {
    endRecord();
  }
  return records;
}

/** Header names must be unique and non-empty to address columns later. */
function normalizeHeaders(raw) {
  const seen = new Map();
  return raw.map((name, index) => {
    let base = name.trim();
    if (base === '') base = `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

/**
 * @param {string} text raw CSV document
 * @param {{maxRows?: number}} [options]
 * @returns {{columns: string[], rows: string[][], rowCount: number,
 *            warnings: Array<{row: number, code: string, message: string}>}}
 */
export function parseCsv(text, options = {}) {
  if (typeof text !== 'string') {
    throw badRequest('EMPTY_CSV', 'The uploaded file was empty.');
  }
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (cleaned.trim() === '') {
    throw badRequest('EMPTY_CSV', 'The uploaded file was empty.');
  }

  const records = splitRecords(cleaned);
  // Drop the empty trailing record produced by a file ending in a newline.
  while (
    records.length > 0 &&
    records[records.length - 1].length === 1 &&
    records[records.length - 1][0] === ''
  ) {
    records.pop();
  }
  if (records.length === 0) {
    throw badRequest('EMPTY_CSV', 'The uploaded file was empty.');
  }

  const columns = normalizeHeaders(records[0]);
  if (columns.length === 0) {
    throw badRequest('EMPTY_CSV', 'The uploaded file had no header row.');
  }

  const warnings = [];
  const rows = [];
  const limit = options.maxRows ?? Infinity;

  for (let i = 1; i < records.length; i += 1) {
    if (rows.length >= limit) {
      warnings.push({
        row: i,
        code: 'ROW_LIMIT',
        message: `Only the first ${limit} rows were kept.`,
      });
      break;
    }
    const record = records[i];
    if (record.length < columns.length) {
      warnings.push({
        row: i,
        code: 'MISSING_FIELDS',
        message: `Row ${i} had ${record.length} fields, expected ${columns.length}; padded with empty values.`,
      });
      rows.push(
        record.concat(Array(columns.length - record.length).fill('')),
      );
    } else if (record.length > columns.length) {
      warnings.push({
        row: i,
        code: 'EXTRA_FIELDS',
        message: `Row ${i} had ${record.length} fields, expected ${columns.length}; extra values dropped.`,
      });
      rows.push(record.slice(0, columns.length));
    } else {
      rows.push(record);
    }
  }

  return { columns, rows, rowCount: rows.length, warnings };
}

/** Serialize back to CSV, quoting only what RFC 4180 requires. */
export function toCsv(columns, rows) {
  const escape = (value) => {
    const str = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
  };
  const lines = [columns.map(escape).join(DELIMITER)];
  for (const row of rows) lines.push(row.map(escape).join(DELIMITER));
  return lines.join('\r\n');
}
