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
| Auth     | scrypt (`node:crypto`), HS256 JWTs in an HttpOnly cookie (or Bearer) |
| Frontend | React 19 + TypeScript, built with Vite                              |
| Tests    | `node --test` + coverage, Vitest + Testing Library, Playwright e2e   |

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

The last two commands each keep running: use two terminals. Needs Node 22.5+
(developed on 24).

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
| `POST`   | `/api/auth/logout`          | End this session (204)                       |
| `POST`   | `/api/auth/logout-all`      | End every session of this user (204)         |
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

Every variable the code reads is listed in [.env.example](.env.example) with a
comment; `cp .env.example .env` gives a working development setup once
`JWT_SECRET` is filled in. The backend reads `.env` (repo root or `backend/`)
via `npm run start`/`dev`; the Docker image takes `-e` flags instead.

| Variable | Read by | Default | In production |
| --- | --- | --- | --- |
| `JWT_SECRET` | backend | none | **Required**, ≥ 32 chars; the server exits 1 without it |
| `NODE_ENV` | backend | `development` | `production` (the image sets it): `Secure` cookies, no stack traces, stricter CORS, TRUST_PROXY required |
| `PORT` | backend | `4000` | any |
| `DATABASE_URL` | backend | `./data/datascout.db` | image: `/data/datascout.db` on the volume |
| `JWT_EXPIRES_IN` | backend | `900` (15 min) | image: `900` |
| `TRUST_PROXY` | backend | unset = off | **Required**: the measured proxy hop count, `0` allowed. The server refuses to start without it ([Measuring TRUST_PROXY](#measuring-trust_proxy)) |
| `DEBUG_IP_ENDPOINT` | backend | `0` | `0`; set `1` only while measuring TRUST_PROXY |
| `AUTH_RATE_LIMIT_PER_MIN` | backend | `10` | optional |
| `CORS_ORIGIN` | backend | `http://localhost:5173` (dev); empty (production) | leave empty (same-origin); if set, exact `https://` origins only; `*` refused |
| `MAX_UPLOAD_BYTES` | backend | `10485760` (10 MiB) | optional |
| `ANTHROPIC_API_KEY` | backend | empty | optional; empty → `/ask` answers 503, everything else works |
| `LLM_MODEL` | backend | `claude-sonnet-5` | optional |
| `VITE_API_BASE_URL` | frontend build | empty (relative `/api`) | leave empty |
| `API_PROXY_TARGET` | `vite dev` / `vite preview` | `http://localhost:4000` | not used |
| `API_ORIGIN` | Vercel build (`frontend/vercel.mjs`) | none | **Required** on Vercel: the API's `https://` origin, no path; the build fails otherwise |
| `E2E_API_PORT` / `E2E_WEB_PORT` | Playwright | `4310` / `4311` | not used |

## Authentication

**Accounts.** `POST /api/auth/register` and `/api/auth/login` take
`{ email, password }` (password ≥ 8 chars, stored as a scrypt digest). Both
set the session cookie and also return `{ user, token, expiresIn }`, so
non-browser clients can use `Authorization: Bearer <token>` instead. A sent
`Authorization` header always wins over the cookie.

**The cookie.** `datascout_session`, `HttpOnly; SameSite=Lax; Path=/;
Max-Age=<TTL>`, plus `Secure` when `NODE_ENV=production`. The browser client
never sees or stores the token (no `localStorage`), and sends every request
with `credentials: 'include'`.

**Same origin.** The browser only calls relative `/api/...` paths. Vercel
rewrites them to the API in production (`frontend/vercel.mjs`); Vite's proxy
does the same in dev, preview and e2e. So the cookie is first-party, no CORS
is involved, and the API can run on any domain. Setting `VITE_API_BASE_URL`
to an absolute URL makes the app cross-origin again, which then needs
`CORS_ORIGIN` and a shared registrable domain (a `SameSite=Lax` cookie is
never attached to a cross-site `fetch`).

**Lifetime and sliding sessions.** A token lives `JWT_EXPIRES_IN` seconds
(900 = 15 minutes). A cookie-authenticated request made after half that
lifetime gets the cookie re-set with a fresh token for the same session, at
the user's current `token_version`, with the same flags. An active user stays
signed in; an idle one is signed out 15 minutes after their last request.
There is no refresh token and no extra endpoint. Bearer clients are never
given a cookie; they sign in again when their token expires.

**Signing out.** Both are `POST`, answer 204 and clear the cookie:

- `POST /api/auth/logout` ends **this session only**. Every token carries a
  session id (`sid`) that sliding re-issue keeps; logout records it as
  revoked, so every token the session ever held, copies included, is refused.
  Other devices stay signed in.
- `POST /api/auth/logout-all` ends **every session** of the user by bumping
  their `token_version`, which every token carries.

Only a currently valid token can trigger either one; a stale or revoked token
just gets the cookie cleared, so replaying an old token can never log the
user out. Revoked `sid`s are kept only until no token of theirs can still be
alive (revocation time + TTL) and pruned on the next write.

**CSRF.** No route that changes state answers `GET` (a test walks the router
to enforce it); cross-site `POST`/`DELETE` carry no `SameSite=Lax` cookie;
production sends no CORS headers, so cross-origin preflights fail. The one
residual: `SameSite` is per *site*, so an untrusted subdomain sharing the
app's registrable domain could still send cookie-bearing `POST`s.

## Sign-in rate limit and proxies

`POST /api/auth/login` and `/api/auth/register` share a per-IP budget of
`AUTH_RATE_LIMIT_PER_MIN` requests (default 10) in any sliding 60-second
window. The next request gets `429 RATE_LIMITED` with `Retry-After` in whole
seconds. Other routes, including logout, are never limited.

**The limiter is in-memory, per process: run one API instance.** Restarting
the API (a deploy, a crash, `docker restart`) resets every counter, and two
replicas would each keep their own, so a client spread across N replicas gets
N times the budget. That is acceptable only because SQLite already pins the
API to one instance.

The store is pluggable for when that changes. `src/auth/rateLimit.js` defines
the interface, one async, atomic method:

```
hit(key, nowMs, windowMs, limit) -> Promise<{ allowed, oldestMs }>
```

`createMemoryStore()` is the default. A shared store (e.g. Redis: one Lua
script doing `ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`, `ZRANGE`, `PEXPIRE` on a
sorted set per key) implements the same method and is passed to
`createApp(config, db, { rateLimitStore })`. Redis is not included. If the
store throws, the sign-in fails with 500 rather than going unlimited.

The client IP comes from the socket unless `TRUST_PROXY` says how many proxy
hops to believe in `X-Forwarded-For` (Express `trust proxy` with a hop count):

- **Unset / `0`**: `X-Forwarded-For` is ignored; `req.ip` is the socket peer.
  The default outside production, and right when clients connect directly.
- **`N`**: `req.ip` is the address `N` hops back. Behind proxies this must be
  the *real* number of proxies: too low and every client appears as a proxy
  address and shares **one** rate-limit bucket (one noisy client locks everyone
  out of sign-in); too high and a client can put any address in
  `X-Forwarded-For` and get a fresh bucket per request.
- **Production requires it to be set.** With `NODE_ENV=production` and no
  `TRUST_PROXY`, the server refuses to start and says to measure it. The
  Docker image deliberately does not set it. `0` is accepted (a measured "no
  proxies"); whether a value is right is not something code can check, so
  measure it.

Never expose the container directly to the internet while it trusts
`X-Forwarded-For`: a client that bypasses the proxies can forge the header.

### Measuring TRUST_PROXY

Do this once per deployment topology (e.g. Vercel rewrite, then host router,
then container), and again whenever a proxy is added or removed.

1. Deploy the API with `TRUST_PROXY=0` and `DEBUG_IP_ENDPOINT=1`. The server
   logs a warning while the endpoint is mounted.
2. From your own machine, find your public address:
   `curl -s https://api.ipify.org`, call it `MY_IP`.
3. Call the endpoint **the way real users reach the API**, through the
   frontend's rewrite: `curl -s https://app.example.com/api/_debug/ip`
4. The response contains `chain`: the socket peer first, then the
   `X-Forwarded-For` entries from nearest to farthest proxy. Find `MY_IP` in
   `chain`; **its index is the hop count `N`** (`req.ip` is always
   `chain[TRUST_PROXY]`). If `MY_IP` is not in `chain` at all, a proxy is not
   forwarding the header: fix that first, per-client limiting is impossible.
5. Redeploy with `TRUST_PROXY=N`, flag still on, and repeat step 3: `ip` must
   now equal `MY_IP`. Also curl the host's own URL directly, if it has one: if
   that also answers, the container is reachable around the proxies and anyone
   can forge `X-Forwarded-For`, so restrict it to the proxy before going live.
6. Redeploy without `DEBUG_IP_ENDPOINT` (or with `0`). Step 3 must now be 404.

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
  -e TRUST_PROXY=<measured hop count> \
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
- The image does **not** set `TRUST_PROXY`, and in production the server will
  not start without it. Measure it first ("Measuring TRUST_PROXY"), then pass
  `-e TRUST_PROXY=<N>`; keep the container reachable only through the proxies.
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
backend/            Express API, CSV engine, SQLite persistence, Dockerfile
  src/auth/         password hashing, JWT, session cookie, sessions (sliding,
                    logout, logout-all), rate limiter + pluggable store
  src/csv/          parse, profile, query, anomalies (framework-free)
  src/llm/          the model provider and QuerySpec validation for /ask
  src/routes/       health, auth, datasets, and the flag-gated _debug route
  test/             node --test suites (the 8 pre-existing files are frozen)
frontend/           React + TypeScript client
  src/              pages, components, API client, auth context, *.test.tsx
  vercel.mjs        Vercel config: /api rewrite to API_ORIGIN, SPA fallback
  vite.config.ts    dev/preview /api proxy, Vitest config
e2e/                Playwright specs against the built app and a real API
scripts/verify.sh   the full acceptance gate (frozen)
scripts/goal-check.sh  proves the gate and frozen tests are unchanged
```

## Troubleshooting

- **The API exits with "TRUST_PROXY must be set in production".** Intended:
  measure the hop count ([Measuring TRUST_PROXY](#measuring-trust_proxy)) and
  set it; `0` if clients connect directly.
- **Signed out after a while.** Sessions end 15 minutes after the last
  request (`JWT_EXPIRES_IN`); activity keeps them alive.
- **401 on every request after signing in (custom setup).** The app is being
  served cross-site from the API with an absolute `VITE_API_BASE_URL`; leave
  it empty so `/api` goes through the rewrite or proxy.
- **Everyone gets 429 on sign-in behind a proxy.** `TRUST_PROXY` is too low,
  so all clients share the proxy's IP. Measure it.
- **`/ask` answers 503.** `ANTHROPIC_API_KEY` is not set; everything else
  works without it.
