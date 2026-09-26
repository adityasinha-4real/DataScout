import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite through Node's built-in driver: no external service to run, and
 * ":memory:" gives the test suite a database that cannot reach dev data.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS datasets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  columns_json  TEXT NOT NULL,
  rows_json     TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_datasets_user ON datasets(user_id, created_at DESC);
`;

export function openDatabase(databaseUrl) {
  if (databaseUrl !== ':memory:') {
    mkdirSync(dirname(databaseUrl), { recursive: true });
  }
  const db = new DatabaseSync(databaseUrl);
  db.exec('PRAGMA foreign_keys = ON;');
  applySchema(db);
  return db;
}

/**
 * Creates the tables, then brings a database made by an older version up to
 * date. CREATE TABLE IF NOT EXISTS leaves an existing table alone, so a column
 * added later has to be added explicitly. Every step is idempotent.
 */
export function applySchema(db) {
  db.exec(SCHEMA);
  const userColumns = db
    .prepare('PRAGMA table_info(users)')
    .all()
    .map((column) => column.name);
  if (!userColumns.includes('token_version')) {
    // Existing accounts start at version 0; their old tokens carry no version
    // at all, so they stop working and those users sign in once more.
    db.exec(
      'ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0',
    );
  }
}

/** Cheap liveness probe used by /api/health. */
export function isConnected(db) {
  try {
    return db.prepare('SELECT 1 AS ok').get().ok === 1;
  } catch {
    return false;
  }
}
