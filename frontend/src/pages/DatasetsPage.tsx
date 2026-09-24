import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { DatasetSummary } from '../lib/types';

export function DatasetsPage() {
  const { token, user, logout } = useAuth();
  const navigate = useNavigate();

  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!token) return;
    const result = await api.listDatasets(token);
    setDatasets(result.datasets);
  }, [token]);

  useEffect(() => {
    refresh().catch((err: unknown) =>
      setError(err instanceof ApiError ? err.message : 'Could not load datasets.'),
    );
  }, [refresh]);

  /** The file is read in the browser and posted as text/csv. */
  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !token) return;

    setError(null);
    setBusy(true);
    try {
      const text = await file.text();
      const name = file.name.replace(/\.csv$/i, '') || 'Untitled';
      const { dataset } = await api.uploadDataset(token, name, text);
      await refresh();
      navigate(`/datasets/${dataset.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function onDelete(id: string) {
    if (!token) return;
    try {
      await api.deleteDataset(token, id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed.');
    }
  }

  return (
    <main className="card">
      <header className="row between">
        <h1>Your datasets</h1>
        <div className="row">
          <span className="muted" data-testid="current-user">
            {user?.email}
          </span>
          <button type="button" onClick={logout} data-testid="logout">
            Sign out
          </button>
        </div>
      </header>

      <label className="uploader" htmlFor="csv-file">
        <span>Upload a CSV</span>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          data-testid="csv-input"
          onChange={onFile}
          disabled={busy}
        />
      </label>

      {error && (
        <p className="error" role="alert" data-testid="upload-error">
          {error}
        </p>
      )}

      {datasets.length === 0 ? (
        <p className="muted" data-testid="empty-state">
          No datasets yet. Upload a CSV to get started.
        </p>
      ) : (
        <ul className="list" data-testid="dataset-list">
          {datasets.map((dataset) => (
            <li key={dataset.id}>
              <Link to={`/datasets/${dataset.id}`} data-testid="dataset-link">
                {dataset.name}
              </Link>
              <span className="muted">
                {dataset.rowCount} rows · {dataset.columns.length} columns
              </span>
              <button
                type="button"
                className="ghost"
                onClick={() => void onDelete(dataset.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
