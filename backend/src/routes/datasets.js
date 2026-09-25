import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { badRequest, notFound, unavailable } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import { parseCsv, toCsv } from '../csv/parse.js';
import { profileDataset } from '../csv/profile.js';
import { detectAnomalies, flaggedRowIndexes } from '../csv/anomalies.js';
import { queryRows } from '../csv/query.js';
import {
  buildPrompt,
  explainSpec,
  parseSpec,
  resolveSpec,
} from '../llm/querySpec.js';
import { validate } from './auth.js';

const uploadQuery = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

const rowsQuery = z.object({
  filter: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value === undefined) return [];
      return Array.isArray(value) ? value : [value];
    }),
  sort: z.string().trim().min(1).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  rankBy: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(1000).optional(),
  anomaliesOnly: z.enum(['true', 'false']).optional(),
});

const summary = (row) => ({
  id: row.id,
  name: row.name,
  rowCount: row.row_count,
  columns: JSON.parse(row.columns_json),
  warnings: JSON.parse(row.warnings_json),
  createdAt: row.created_at,
});

const askBody = z.object({
  question: z.string().trim().min(1).max(500),
});

export function datasetsRouter(config, db, llm = null) {
  const router = Router();
  router.use('/datasets', requireAuth(config, db));

  /** Datasets are scoped to their owner: another user's id reads as absent. */
  const load = (req) => {
    const row = db
      .prepare('SELECT * FROM datasets WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!row) throw notFound('No dataset with that id.');
    return row;
  };

  const parsed = (row) => ({
    columns: JSON.parse(row.columns_json),
    rows: JSON.parse(row.rows_json),
  });

  const anomaliesOf = ({ columns, rows }) =>
    detectAnomalies(rows, profileDataset(columns, rows));

  /** `anomaliesOnly=true` narrows the query to rows flagged in any column. */
  const onlyRowsFor = (q, data) =>
    q.anomaliesOnly === 'true' ? flaggedRowIndexes(anomaliesOf(data)) : undefined;

  router.post('/datasets', (req, res) => {
    const { name } = validate(uploadQuery, req.query);
    if (typeof req.body !== 'string') {
      throw badRequest(
        'UNSUPPORTED_CONTENT_TYPE',
        'Upload the file with Content-Type: text/csv.',
      );
    }

    const { columns, rows, rowCount, warnings } = parseCsv(req.body);
    const dataset = {
      id: randomUUID(),
      user_id: req.user.id,
      name: name ?? `Dataset ${new Date().toISOString().slice(0, 10)}`,
      columns_json: JSON.stringify(columns),
      rows_json: JSON.stringify(rows),
      warnings_json: JSON.stringify(warnings),
      row_count: rowCount,
      created_at: new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO datasets
         (id, user_id, name, columns_json, rows_json, warnings_json, row_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dataset.id,
      dataset.user_id,
      dataset.name,
      dataset.columns_json,
      dataset.rows_json,
      dataset.warnings_json,
      dataset.row_count,
      dataset.created_at,
    );

    res.status(201).json({ dataset: summary(dataset) });
  });

  router.get('/datasets', (req, res) => {
    const rows = db
      .prepare(
        'SELECT * FROM datasets WHERE user_id = ? ORDER BY created_at DESC, id',
      )
      .all(req.user.id);
    res.json({ datasets: rows.map(summary) });
  });

  router.get('/datasets/:id', (req, res) => {
    res.json({ dataset: summary(load(req)) });
  });

  router.get('/datasets/:id/profile', (req, res) => {
    const row = load(req);
    const { columns, rows } = parsed(row);
    res.json({ datasetId: row.id, profile: profileDataset(columns, rows) });
  });

  router.get('/datasets/:id/rows', (req, res) => {
    const row = load(req);
    const q = validate(rowsQuery, req.query);
    const data = parsed(row);
    const result = queryRows(data, {
      onlyRows: onlyRowsFor(q, data),
      filters: q.filter,
      sort: q.sort,
      direction: q.direction,
      rankBy: q.rankBy,
      page: q.page,
      pageSize: q.pageSize,
    });
    res.json({ datasetId: row.id, ...result });
  });

  router.get('/datasets/:id/export', (req, res) => {
    const row = load(req);
    const q = validate(rowsQuery, req.query);
    // Export ignores pagination on purpose: you get every matching row.
    const data = parsed(row);
    const all = queryRows(data, {
      onlyRows: onlyRowsFor(q, data),
      filters: q.filter,
      sort: q.sort,
      direction: q.direction,
      rankBy: q.rankBy,
      paginate: false,
    });

    res.type('text/csv').set(
      'Content-Disposition',
      `attachment; filename="${row.name.replace(/[^\w.-]+/g, '_')}.csv"`,
    );
    res.send(toCsv(all.columns, all.rows.map((entry) => entry.row)));
  });

  /**
   * Statistical outliers per numeric column. Deliberately a separate route
   * from /profile: the profile feeds the /ask prompt, and which rows are
   * anomalous must never travel that way.
   */
  router.get('/datasets/:id/anomalies', (req, res) => {
    const row = load(req);
    res.json({ datasetId: row.id, columns: anomaliesOf(parsed(row)) });
  });

  /**
   * Plain English in, a validated QuerySpec out, the existing engine doing the
   * work. The model sees the column catalogue and the question; it never sees
   * a cell, and nothing it returns is executed — it is checked against the
   * schema and then against this dataset's real columns before it runs.
   */
  router.post('/datasets/:id/ask', async (req, res) => {
    const row = load(req);
    const { question } = validate(askBody, req.body ?? {});
    if (!llm) {
      throw unavailable(
        'LLM_UNAVAILABLE',
        'Natural-language search is not configured on this server.',
      );
    }

    const { columns, rows } = parsed(row);
    const profile = profileDataset(columns, rows);

    const answer = await llm.complete(
      buildPrompt({ profile, question, rowCount: rows.length }),
    );
    const spec = parseSpec(answer);
    const result = queryRows({ columns, rows }, resolveSpec(spec, profile));

    res.json({
      datasetId: row.id,
      spec,
      explanation: explainSpec(spec),
      ...result,
    });
  });

  router.delete('/datasets/:id', (req, res) => {
    const row = load(req);
    db.prepare('DELETE FROM datasets WHERE id = ?').run(row.id);
    res.status(204).end();
  });

  return router;
}
