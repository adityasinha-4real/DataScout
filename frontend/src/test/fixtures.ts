import type { Reply, RecordedRequest } from './api';
import { USER, ok } from './api';

/** The AC-T5 spike fixture: value = 10,11,12,11,10,12,11,95. */
export const COLUMNS = ['label', 'value', 'note'];
export const ROWS = [
  ['a', '10', 'x'],
  ['b', '11', 'x'],
  ['c', '12', 'x'],
  ['d', '11', 'x'],
  ['e', '10', 'x'],
  ['f', '12', 'x'],
  ['g', '11', 'x'],
  ['h', '95', 'x'],
];

export const DATASET = {
  id: 'ds1',
  name: 'Spike',
  rowCount: ROWS.length,
  columns: COLUMNS,
  warnings: [],
  createdAt: '2026-01-01T00:00:00Z',
};

export const PROFILE = {
  rowCount: ROWS.length,
  columns: [
    { name: 'label', index: 0, type: 'string', count: 8, missing: 0, unique: 8 },
    {
      name: 'value',
      index: 1,
      type: 'number',
      count: 8,
      missing: 0,
      unique: 4,
      stats: { min: 10, max: 95, mean: 21.5, median: 11, stddev: 27.8, sum: 172 },
    },
    { name: 'note', index: 2, type: 'string', count: 8, missing: 0, unique: 1 },
  ],
};

export const ANOMALIES = {
  datasetId: 'ds1',
  columns: [
    {
      column: 'value',
      insufficientData: false,
      flagged: [{ row: 7, value: 95, rules: ['iqr', 'robustZ'] }],
    },
  ],
};

/** A /rows reply for these source-row indexes, shaped like the API's. */
export function rowsReply(indexes: number[], ranks?: number[]): Reply {
  return ok({
    datasetId: 'ds1',
    columns: COLUMNS,
    rows: indexes.map((index, i) => ({
      row: ROWS[index],
      rank: ranks?.[i] ?? null,
      index,
    })),
    total: indexes.length,
    page: 1,
    pageSize: 25,
    pageCount: 1,
  });
}

const ALL = ROWS.map((_, index) => index);

/**
 * Everything the dataset page loads, for a signed-in user. `rows` decides
 * what /rows answers, so a test can make the reply depend on what was asked.
 */
export function datasetRoutes(
  rows: (request: RecordedRequest) => Reply = () => rowsReply(ALL),
  anomalies: unknown = ANOMALIES,
) {
  return {
    'GET /api/auth/me': () => ok({ user: USER }),
    'GET /api/datasets/:id': () => ok({ dataset: DATASET }),
    'GET /api/datasets/:id/profile': () => ok({ datasetId: 'ds1', profile: PROFILE }),
    'GET /api/datasets/:id/anomalies': () => ok(anomalies),
    'GET /api/datasets/:id/rows': rows,
  };
}
