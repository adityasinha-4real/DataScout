import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { AskBox } from '../components/AskBox';
import { api, ApiError, type RowsQuery } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { DatasetProfile, DatasetSummary, RowsPage } from '../lib/types';

const OPERATORS = [
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
] as const;

export function DatasetPage() {
  const { token } = useAuth();
  const { id = '' } = useParams<{ id: string }>();

  const [dataset, setDataset] = useState<DatasetSummary | null>(null);
  const [profile, setProfile] = useState<DatasetProfile | null>(null);
  const [page, setPage] = useState<RowsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [column, setColumn] = useState('');
  const [operator, setOperator] = useState<(typeof OPERATORS)[number]>('eq');
  const [value, setValue] = useState('');
  const [applied, setApplied] = useState<string[]>([]);
  const [rankBy, setRankBy] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [exported, setExported] = useState<number | null>(null);

  // Memoised so it can be a stable effect dependency rather than a new object
  // on every render.
  const query = useMemo<RowsQuery>(
    () => ({
      filters: applied,
      rankBy: rankBy || undefined,
      page: pageNumber,
      pageSize: 25,
    }),
    [applied, rankBy, pageNumber],
  );

  useEffect(() => {
    if (!token || !id) return;
    Promise.all([api.getDataset(token, id), api.getProfile(token, id)])
      .then(([summary, profileResult]) => {
        setDataset(summary.dataset);
        setProfile(profileResult.profile);
        setColumn((current) => current || (summary.dataset.columns[0] ?? ''));
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not load dataset.'),
      );
  }, [token, id]);

  const loadRows = useCallback(async () => {
    if (!token || !id) return;
    try {
      setPage(await api.getRows(token, id, query));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load rows.');
    }
  }, [token, id, query]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  function addFilter() {
    if (!column) return;
    const needsValue = !['empty', 'notEmpty'].includes(operator);
    if (needsValue && value.trim() === '') return;
    setApplied((current) => [
      ...current,
      needsValue ? `${column}:${operator}:${value.trim()}` : `${column}:${operator}`,
    ]);
    setValue('');
    setPageNumber(1);
  }

  async function onExport() {
    if (!token || !id) return;
    try {
      const csv = await api.exportCsv(token, id, { ...query, page: undefined });
      // Count data rows, not the header line.
      setExported(csv.trim().split(/\r?\n/).length - 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Export failed.');
    }
  }

  if (error && !dataset) {
    return (
      <main className="card">
        <p className="error" role="alert" data-testid="dataset-error">
          {error}
        </p>
        <Link to="/datasets">Back to datasets</Link>
      </main>
    );
  }

  return (
    <main className="card">
      <header className="row between">
        <h1 data-testid="dataset-name">{dataset?.name ?? 'Loading…'}</h1>
        <Link to="/datasets">Back to datasets</Link>
      </header>

      {dataset && (
        <p className="muted" data-testid="dataset-summary">
          {dataset.rowCount} rows · {dataset.columns.length} columns
        </p>
      )}

      {dataset && dataset.warnings.length > 0 && (
        <p className="warning" data-testid="dataset-warnings">
          {dataset.warnings.length} row(s) needed repair during import.
        </p>
      )}

      {profile && (
        <section>
          <h2>Columns</h2>
          <table data-testid="profile-table">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Missing</th>
                <th>Unique</th>
                <th>Range</th>
              </tr>
            </thead>
            <tbody>
              {profile.columns.map((col) => (
                <tr key={col.name} data-testid={`profile-row-${col.name}`}>
                  <td>{col.name}</td>
                  <td>{col.type}</td>
                  <td>{col.missing}</td>
                  <td>{col.unique}</td>
                  <td>
                    {col.stats
                      ? `${col.stats.min} – ${col.stats.max} (mean ${col.stats.mean})`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <AskBox
        onAsk={async (question) => {
          if (!token || !id) throw new Error('Not signed in.');
          return api.ask(token, id, question);
        }}
        onApply={(filters, rank) => {
          setApplied(filters);
          setRankBy(rank);
          setPageNumber(1);
        }}
      />

      <section>
        <h2>Rows</h2>
        <div className="controls">
          <select
            aria-label="Filter column"
            data-testid="filter-column"
            value={column}
            onChange={(event) => setColumn(event.target.value)}
          >
            {(dataset?.columns ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter operator"
            data-testid="filter-operator"
            value={operator}
            onChange={(event) =>
              setOperator(event.target.value as (typeof OPERATORS)[number])
            }
          >
            {OPERATORS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>

          <input
            aria-label="Filter value"
            data-testid="filter-value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />

          <button type="button" data-testid="add-filter" onClick={addFilter}>
            Add filter
          </button>

          <select
            aria-label="Rank by"
            data-testid="rank-by"
            value={rankBy}
            onChange={(event) => {
              setRankBy(event.target.value);
              setPageNumber(1);
            }}
          >
            <option value="">No ranking</option>
            {(profile?.columns ?? [])
              .filter((col) => col.type === 'number')
              .map((col) => (
                <option key={col.name} value={col.name}>
                  Rank by {col.name}
                </option>
              ))}
          </select>

          <button type="button" data-testid="export" onClick={() => void onExport()}>
            Export CSV
          </button>
        </div>

        {applied.length > 0 && (
          <ul className="chips" data-testid="active-filters">
            {applied.map((filter) => (
              <li key={filter}>
                <code>{filter}</code>
                <button
                  type="button"
                  aria-label={`Remove filter ${filter}`}
                  onClick={() =>
                    setApplied((current) => current.filter((f) => f !== filter))
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && (
          <p className="error" role="alert" data-testid="rows-error">
            {error}
          </p>
        )}

        {exported !== null && (
          <p className="muted" data-testid="export-result">
            Exported {exported} rows
          </p>
        )}

        <p data-testid="row-count">
          {page ? `${page.total} matching rows` : 'Loading rows…'}
        </p>

        {page && (
          <>
            <table data-testid="rows-table">
              <thead>
                <tr>
                  {rankBy && <th>Rank</th>}
                  {page.columns.map((name) => (
                    <th key={name}>{name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((entry, index) => (
                  <tr key={`${entry.row.join('|')}-${index}`} data-testid="row">
                    {rankBy && <td data-testid="rank-cell">{entry.rank}</td>}
                    {entry.row.map((cell, cellIndex) => (
                      <td key={`${page.columns[cellIndex] ?? cellIndex}`}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="row">
              <button
                type="button"
                data-testid="prev-page"
                disabled={page.page <= 1}
                onClick={() => setPageNumber((n) => Math.max(1, n - 1))}
              >
                Previous
              </button>
              <span data-testid="page-indicator">
                Page {page.page} of {page.pageCount}
              </span>
              <button
                type="button"
                data-testid="next-page"
                disabled={page.page >= page.pageCount}
                onClick={() => setPageNumber((n) => n + 1)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
