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
npm test --prefix frontend         # Vitest + Testing Library component tests (jsdom)
npm test --prefix e2e              # Playwright smoke (boots API + preview build)
```

The frontend tests render the real app and mock only `fetch`, so the API
client, auth context, router and components all run as shipped. A request no
test declared fails the test rather than being silently swallowed.

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

All dataset routes require the session cookie set at sign-in, or an
`Authorization: Bearer <token>` header. Every
error response has the shape `{ "error": { "code": "...", "message": "..." } }`.

| Method   | Path                        | Purpose                                     |
| -------- | --------------------------- | ------------------------------------------- |
| `GET`    | `/api/health`               | Liveness plus database connectivity          |
| `POST`   | `/api/auth/register`        | Create an account, returns a token           |
| `POST`   | `/api/auth/login`           | Exchange credentials for a token             |
| `GET`    | `/api/auth/me`              | The current user                             |
| `POST`   | `/api/auth/logout`          | Clear the session cookie (204)               |
| `POST`   | `/api/datasets?name=`       | Upload CSV as `Content-Type: text/csv`       |
| `GET`    | `/api/datasets`             | List your datasets                           |
| `GET`    | `/api/datasets/:id`         | One dataset's summary                        |
| `GET`    | `/api/datasets/:id/profile` | Per-column type inference and statistics     |
| `GET`    | `/api/datasets/:id/rows`    | Filter, sort, rank and paginate rows         |
| `GET`    | `/api/datasets/:id/export`  | Every matching row as CSV                    |
| `GET`    | `/api/datasets/:id/anomalies` | Outliers per numeric column (IQR, robust z) |
| `POST`   | `/api/datasets/:id/ask`     | Plain-English question → validated query     |
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

### Asking a question, and what the model sees

`POST /api/datasets/:id/ask` sends the model the question plus a column
catalogue: each column's name, type, missing and unique counts, the operators
it supports, and for numeric columns `min`, `max`, `mean`, `median`, `stddev`
and `sum`. No row, no cell text and no categorical top values are sent. The
model answers with a query spec that is validated against the real columns
and run by the same engine as `/rows`; nothing it returns is executed.

**Known behaviour: `min` and `max` can be outlier values.** They are computed
over every value in the column, so on a column like `10, 11, 12, 11, 95` the
model is told `max: 95` even though `/anomalies` flags 95 as an outlier. The
`/anomalies` result itself (which rows, which rules) is never sent, but its
extreme values reach the model through `min`/`max`. They are parsed finite
numbers, so they cannot carry an instruction; the exposure is the number
alone. This was a deliberate choice to keep the AC-T4 behaviour unchanged.

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

### Sessions and origins

Signing in sets an `HttpOnly; SameSite=Lax; Path=/` cookie (plus `Secure` when
`NODE_ENV=production`), and the browser client authenticates with that cookie
alone — it never stores the token. API clients can still send
`Authorization: Bearer <token>` from the login response.

`POST /api/auth/logout` clears the cookie **and revokes every token issued
before it**: each user has a `token_version`, every token carries the version
it was issued at, and logout increments it. A copy of the token taken off the
machine is refused from then on, on every device. Signing in again issues a
token at the new version. Only a currently valid token can trigger that bump,
so replaying an old one cannot keep logging the user out.

Tokens live `JWT_EXPIRES_IN` seconds: 900 (15 minutes) in the production image
and `.env.example`. There is no refresh token, so after 15 minutes the user
signs in again. (Unset, the code falls back to 3600.)

The browser only ever calls relative `/api/...` paths on the page's own
origin. In production Vercel rewrites them to the API (`frontend/vercel.mjs`);
in dev and e2e Vite's proxy does the same (`frontend/vite.config.ts`). So the
cookie is first-party, no CORS is involved, and the API can live on any
domain.

- Leave `VITE_API_BASE_URL` blank. An absolute URL makes the app cross-origin
  again, which then needs `CORS_ORIGIN` and a shared registrable domain
  (browsers never attach a `SameSite=Lax` cookie to a cross-site `fetch`).
- `CORS_ORIGIN` is empty by default in production, so the API sends no CORS
  headers to anyone. If set, it must list exact `https://` origins; `*` is
  refused at boot.
- `Secure` cookies are only sent over HTTPS, so production runs behind TLS.

### Sign-in rate limit and proxies

`POST /api/auth/login` and `/api/auth/register` share a per-IP budget of
`AUTH_RATE_LIMIT_PER_MIN` requests (default 10) in any sliding 60-second
window. The next request gets `429 RATE_LIMITED` with `Retry-After` in whole
seconds. Other routes, including logout, are never limited.

**The limiter is in-memory, per process.** Restarting the API (a deploy, a
crash, `docker restart`) resets every counter, and two replicas would each
keep their own, so a client spread across N replicas gets N× the budget.
That is acceptable here only because SQLite already pins the API to one
instance; scaling out would need a shared store (e.g. Redis) for the limiter
as well as a networked database.

The client IP comes from the socket unless `TRUST_PROXY` says how many proxy
hops to believe in `X-Forwarded-For`:

- `TRUST_PROXY=0` — the **code default**. `X-Forwarded-For` is ignored, so a
  client cannot pick its own IP. Right for local dev and for clients
  connecting straight to the process.
- `TRUST_PROXY=1` — **set in the production image** (`backend/Dockerfile`).
  In production the API always sits behind a proxy; with `0`, `req.ip` would
  be the proxy's address on every request and *all clients would share one
  rate-limit bucket*, so one noisy client locks everyone out of sign-in.
- `TRUST_PROXY=2` — when two proxies stand in front, e.g. Vercel's rewrite
  *and* the API host's own router: with `1`, every client would appear as a
  Vercel egress address. Count the hops for your host and set it exactly.

Never set it higher than the real number of hops, and do not expose the
container directly to the internet while it trusts the header: a client that
can reach it without the proxy can put any address in `X-Forwarded-For`.

## Deployment

Nothing here deploys anything; these are the steps and the constraints.

```
browser ──https──▶ app.example.com (Vercel)
                     ├─ static files from frontend/dist
                     └─ /api/*  ──rewrite──▶  $API_ORIGIN/api/*  (the container)
```

The browser talks to one origin only. The API's address is configuration
(`API_ORIGIN` in the Vercel project), never a literal in the code.

### API: Docker

```bash
docker build -t datascout-api backend
docker run -d --name datascout-api -p 4000:4000 \
  -v datascout-data:/data \
  -e JWT_SECRET="$(openssl rand -hex 48)" \
  datascout-api
```

- The image sets `NODE_ENV=production`, so cookies are `Secure`: serve the API
  over HTTPS (a platform router or a TLS-terminating proxy in front), since
  Vercel's rewrite forwards the session cookie to it.
- No `CORS_ORIGIN` is needed: every browser request arrives via the same-origin
  rewrite. Leave it unset and the API answers no cross-origin request.
- The database is `/data/datascout.db` on the `datascout-data` volume. Replace
  the container freely; keep the volume. Back it up by copying that file while
  the container is stopped.
- SQLite means **one** API instance. Do not run replicas against the same
  volume, and note the sign-in rate limit is per process too.
- The image sets `TRUST_PROXY=1` (see "Sign-in rate limit and proxies"):
  use `-e TRUST_PROXY=2` if both Vercel's rewrite and your host's router sit
  in front, and keep the container reachable only through them.
- Runs as the unprivileged `node` user, with a `HEALTHCHECK` on `/api/health`.
  `docker stop` shuts it down cleanly on SIGTERM.
- Set `ANTHROPIC_API_KEY` (and optionally `LLM_MODEL`) to enable "Ask a
  question"; without it `/ask` answers 503 and everything else works.

### Frontend: Vercel

1. Import the repo and set **Root Directory** to `frontend`. Vercel detects
   Vite: build `npm run build`, output `dist`.
2. Add the environment variable `API_ORIGIN=https://api.example.com` (the
   container's https origin, no path). `frontend/vercel.mjs` reads it at build
   time and **fails the build** if it is missing, not https, or has a path.
   Redeploy after changing it.
3. Leave `VITE_API_BASE_URL` unset.

`vercel.mjs` (it replaces `vercel.json`; Vercel allows only one) defines two
rewrites, in order: `/api/:path*` → `$API_ORIGIN/api/:path*`, then everything
else → `index.html`, so a refresh on `/datasets/<id>` loads the app. Real
files in `dist/` are served before either rewrite applies.

Preview deployments get their own origin and rewrite to whatever
`API_ORIGIN` the Preview environment sets — point it at a staging API, or
previews will read and write production data.

## Project layout

```
backend/    Express API, CSV engine, SQLite persistence (Dockerfile)
  src/csv/  parse, profile and query — framework-free and unit tested
frontend/   React + TypeScript client
e2e/        Playwright smoke test of the primary user flow
scripts/    verify.sh — the full acceptance gate
```
