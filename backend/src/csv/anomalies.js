/**
 * Outlier detection for numeric columns. Two independent rules, both robust to
 * the outliers they are looking for:
 *
 * - `iqr`: outside [Q1 − 1.5·IQR, Q3 + 1.5·IQR], quartiles by linear
 *   interpolation between order statistics.
 * - `robustZ`: |x − median| / (1.4826·MAD) > 3.5, the Iglewicz–Hoaglin
 *   modified z-score (1 / 1.4826 is the 0.6745 in its usual statement). The
 *   1.4826 factor makes MAD a consistent estimator of σ for normal data.
 *
 * Every statistic returned is a finite number. The degenerate cases are
 * handled up front rather than left to produce NaN or Infinity: fewer than
 * MIN_VALUES values is reported as insufficient data, and MAD = 0 (more than
 * half the values identical) switches the robust-z rule off, because every
 * deviation would otherwise divide by zero.
 */

import { isBlank, parseNumber } from './profile.js';

export const MIN_VALUES = 4;
export const IQR_MULTIPLIER = 1.5;
export const MAD_SCALE = 1.4826;
export const ROBUST_Z_THRESHOLD = 3.5;

const round = (n) => Math.round(n * 1e6) / 1e6;

/** Linear interpolation between order statistics; `sorted` is ascending. */
export function quantile(sorted, p) {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(sorted) {
  return quantile(sorted, 0.5);
}

/**
 * @param {Array<{row: number, value: number}>} points non-blank numeric cells
 */
export function detectOutliers(points) {
  if (points.length < MIN_VALUES) {
    return { insufficientData: true, flagged: [] };
  }

  const sorted = points.map((p) => p.value).sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - IQR_MULTIPLIER * iqr;
  const upperFence = q3 + IQR_MULTIPLIER * iqr;

  const med = median(sorted);
  const mad = median(
    sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b),
  );
  const scaledMad = MAD_SCALE * mad;

  const flagged = [];
  for (const { row, value } of points) {
    const rules = [];
    if (value < lowerFence || value > upperFence) rules.push('iqr');
    if (scaledMad > 0 && Math.abs(value - med) / scaledMad > ROBUST_Z_THRESHOLD) {
      rules.push('robustZ');
    }
    if (rules.length > 0) flagged.push({ row, value, rules });
  }

  return {
    insufficientData: false,
    stats: {
      q1: round(q1),
      q3: round(q3),
      iqr: round(iqr),
      lowerFence: round(lowerFence),
      upperFence: round(upperFence),
      median: round(med),
      mad: round(mad),
    },
    flagged,
  };
}

/**
 * @param {string[][]} rows
 * @param {{columns: Array<{name: string, index: number, type: string}>}} profile
 */
export function detectAnomalies(rows, profile) {
  return profile.columns
    .filter((column) => column.type === 'number')
    .map((column) => {
      const points = [];
      rows.forEach((row, rowIndex) => {
        const cell = row[column.index];
        // Blanks are absent, not zero: counting them would drag the quartiles
        // toward 0 and flag perfectly ordinary values.
        if (isBlank(cell)) return;
        const value = parseNumber(cell);
        if (value !== null) points.push({ row: rowIndex, value });
      });
      return { column: column.name, ...detectOutliers(points) };
    });
}

/** Source-row indexes flagged in any column, for the "anomalies only" view. */
export function flaggedRowIndexes(anomalies) {
  const indexes = new Set();
  for (const column of anomalies) {
    for (const { row } of column.flagged) indexes.add(row);
  }
  return indexes;
}
