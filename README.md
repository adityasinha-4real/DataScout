# DataScout

Upload a CSV, see what is actually in it, and rank what matters.

DataScout parses an uploaded CSV, profiles every column (type, missing values,
distinct values, numeric distribution), and lets you filter, sort, dense-rank
and export the rows — all behind a per-user account, so one person's datasets
are never visible to another.

## Stack

| Layer    | Choice                                                            |
| -------- | ----------------------------------------------------------------- |
| Backend  | Node 22+ (ESM), Express 5, SQLite via Node's built-in `node:sqlite` |
| Auth     | scrypt password hashing (`node:crypto`), HS256 JWT bearer tokens    |
| Frontend | React 19 + TypeScript, built with Vite                              |
| Tests    | `node --test` with built-in coverage; Playwright for the e2e smoke  |

There is no external database server to install: `node:sqlite` writes a local
file in development and runs entirely in memory under test.

## Quick start

```bash
cp .env.example .env
npm ci --prefix backend
npm ci --prefix frontend
npm ci --prefix e2e
npm run start --prefix backend
npm run dev --prefix frontend
```

Edit `.env` first — `JWT_SECRET` is required and must be at least 32
characters. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The API then listens on <http://localhost:4000> and the app on
<http://localhost:5173>. Check the API with `curl http://localhost:4000/api/health`,
which answers `{"status":"ok","db":"connected", ...}`.

## Tests

```bash
npm test --prefix backend          # unit + integration, with coverage
npm run lint --prefix backend      # also: --prefix frontend, --prefix e2e
npm run build --prefix frontend    # type-check + production bundle
npm test --prefix e2e              # Playwright smoke (boots API + preview build)
```

The e2e suite builds the frontend and boots the API itself on private ports
with an in-memory database, so it never touches your development data. It
needs a browser binary once:

```bash
npm run install-browsers --prefix e2e
```

To run every acceptance check at once:

```bash
bash scripts/verify.sh
```

## API

All dataset routes require an `Authorization: Bearer <token>` header. Every
error response has the shape `{ "error": { "code": "...", "message": "..." } }`.

| Method   | Path                        | Purpose                                     |
| -------- | --------------------------- | ------------------------------------------- |
| `GET`    | `/api/health`               | Liveness plus database connectivity          |
| `POST`   | `/api/auth/register`        | Create an account, returns a token           |
| `POST`   | `/api/auth/login`           | Exchange credentials for a token             |
| `GET`    | `/api/auth/me`              | The current user                             |
| `POST`   | `/api/datasets?name=`       | Upload CSV as `Content-Type: text/csv`       |
| `GET`    | `/api/datasets`             | List your datasets                           |
| `GET`    | `/api/datasets/:id`         | One dataset's summary                        |
| `GET`    | `/api/datasets/:id/profile` | Per-column type inference and statistics     |
| `GET`    | `/api/datasets/:id/rows`    | Filter, sort, rank and paginate rows         |
| `GET`    | `/api/datasets/:id/export`  | Every matching row as CSV                    |
| `DELETE` | `/api/datasets/:id`         | Delete a dataset                             |

### Querying rows

Filters are repeatable `filter=column:operator:value` parameters, combined with
AND. Operators: `eq`, `ne`, `contains`, `gt`, `gte`, `lt`, `lte`, `in`
(pipe-separated), `empty`, `notEmpty`.

```
GET /api/datasets/:id/rows?filter=team:eq:Blue&filter=score:gte:30&rankBy=score
```

`rankBy` orders best-first on a numeric column and attaches a **dense** rank:
tied rows share a rank and the next rank is not skipped. `sort` with
`direction=asc|desc` orders without ranking. Blank cells always sort last,
in either direction, so a row with no value is never the top result.

`export` accepts the same parameters and ignores pagination.

## CSV handling

The parser follows RFC 4180: quoted fields may contain commas, newlines and
doubled quotes, and both LF and CRLF line endings work, as does a UTF-8 BOM.
Ragged input is repaired rather than rejected — short rows are padded, long
rows are truncated — and each repair is reported in the dataset's `warnings`
so nothing is silently lost. Duplicate header names are suffixed (`score_2`)
and blank ones become `column_N`.

## Environment

Every variable the code reads is documented in [.env.example](.env.example).
`JWT_SECRET` is required; the server refuses to boot without it rather than
failing later on a request. The frontend reads its API origin from
`VITE_API_BASE_URL` at build time — there is no hardcoded fallback.

## Project layout

```
backend/    Express API, CSV engine, SQLite persistence
  src/csv/  parse, profile and query — framework-free and unit tested
frontend/   React + TypeScript client
e2e/        Playwright smoke test of the primary user flow
scripts/    verify.sh — the full acceptance gate
```
