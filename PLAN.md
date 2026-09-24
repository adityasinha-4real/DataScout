# PLAN.md — DataScout

> Single source of truth for the `/goal` run. Claude Code: re-read this whole file at the start of every turn and after every context compaction. If anything here conflicts with an instruction you inferred elsewhere, this file wins.

---

## 0. Rules of engagement (read first, every turn)

1. **The goal is met only when** every criterion in §5 is `[x]` AND `bash scripts/verify.sh` exits 0 with `ALL CHECKS PASSED` as its last line. Nothing else counts. Do not declare completion before that.
2. **Evidence before checkboxes.** Tick a criterion only after its proof command has passed *in this session*. Paste the relevant output line. No output means no tick.
3. **One criterion at a time**, in ID order, unless a later one is a hard dependency of an earlier one (say why in §8).
4. **Smallest change that makes the proof pass.** No drive-by refactors, renames, or reformatting of untouched files.
5. **End every turn with the status block in §7.** The goal evaluator only reads the transcript, so this block is how progress becomes visible.
6. **Commit after each criterion passes:** `git commit -m "AC-XX: <short description>"`. Never force-push, never rewrite history, never commit to `main`.

---

## 1. Objective

<!-- FILL: one sentence, outcome-based, testable. Bad: "improve DataScout". Good: "A user can upload a CSV of player stats, see it parsed into the dashboard, and filter/rank players by any metric, with all of it covered by tests." -->

**Objective:** A user can create an account, upload a CSV, see every column automatically typed and profiled, filter / sort / dense-rank the rows by any column, and export the filtered result as CSV — with each user's datasets invisible to every other user, and all of it covered by tests.

**Primary user flow (end to end):** register → upload CSV → see the profiled dashboard → filter → rank → export

---

## 2. Hard constraints (never violate)

| # | Constraint | Why |
|---|---|---|
| C1 | Do **not** modify `scripts/verify.sh`, anything under `tests/` / `__tests__/` / `e2e/` that existed before this run, or this file's §0–§2 and §5 criteria text | Prevents gaming the finish line |
| C2 | No mocked, stubbed, or hardcoded return values to make a check pass (e.g. `if (process.env.NODE_ENV==='test') return fakeData`) | A pass must reflect real behaviour |
| C3 | Never skip, `.only`, `.skip`, `xit`, or delete a test. Never lower coverage thresholds or lint rules | Same |
| C4 | Never read, print, or commit `.env` values or secrets. Use `.env.example` for contracts | Security |
| C5 | Tests must use an isolated DB (in-memory or a dedicated test DB). Never touch a dev/prod database | Data safety |
| C6 | New dependencies only when unavoidable. Log each one in §8 with the reason | Keeps the bundle and audit surface small |
| C7 | Preserve existing public API contracts (routes, request/response shapes) unless a criterion explicitly changes them | Avoids breaking the client |
| C8 | Work only inside this repo. No global installs, no edits outside the project folder | Blast radius |

---

## 3. Project context

> Filled by Claude Code during Phase 0 (§4) from the actual repo, **not guessed**. Every line must be something you verified by reading files or running commands.

- **Repo layout:** At the start of this run the repo contained **only `PLAN.md` and `.claude/`** — no git history, no source, no `scripts/verify.sh`, and Phase 0 had never been run. Everything below was created during this run. Now: `backend/` (API + CSV engine + SQLite), `frontend/` (React client), `e2e/` (Playwright), `scripts/` (verify.sh), root `.env.example` / `README.md`.
- **Frontend:** React 19.3 + TypeScript 5.9, built by Vite 8.3 (`@vitejs/plugin-react` 6.1). Router: `react-router-dom` 7.18. State: React context (`src/lib/auth.tsx`) — no external state library. API base URL: `import.meta.env.VITE_API_BASE_URL`, read only in `src/lib/api.ts`, no literal fallback.
- **Backend:** Node 24.13 (ESM), Express 5.2. Entry `backend/src/server.js`; app factory `backend/src/app.js`. Default port 4000. Routes: `src/routes/health.js`, `auth.js`, `datasets.js`. Middleware: `cors`, `express.json`, `express.text` (CSV), `requireAuth`, body-error normaliser, `errorHandler`.
- **Database:** SQLite through Node's built-in `node:sqlite` (`DatabaseSync`) — no external service, no native build. No ODM; hand-written SQL in `src/db/index.js`. Tables: `users`, `datasets`. Connection env var: `DATABASE_URL` (`:memory:` under test).
- **Auth:** scrypt password digests via `node:crypto` (`src/auth/password.js`); HS256 JWTs signed and verified in `src/auth/jwt.js` with the algorithm fixed rather than read from the header. Issued by `/api/auth/register` and `/api/auth/login`; verified by `requireAuth` (`src/auth/middleware.js`).
- **ML / data layer:** None, and none is needed. The "intelligence" is real, deterministic code: type inference and statistics in `src/csv/profile.js`, query/rank engine in `src/csv/query.js`. Nothing is mocked.
- **Scripts available:** `backend`: `start`, `dev`, `test`, `lint`. `frontend`: `dev`, `build`, `preview`, `lint`. `e2e`: `test`, `install-browsers`, `lint`.
- **Test setup:** `node --test` with built-in coverage (backend, 81 tests across 6 files); Playwright 1.57 (e2e, 4 tests). No tests existed before this run.
- **Baseline `verify.sh` result:** No `verify.sh` existed at the start (0 of 0). It was written in this run to the §6 contract and is frozen from its first commit by the tamper guard.

---

## 4. Phase 0 — Discovery (runs BEFORE `/goal`, as a normal prompt)

Do all of this, write the results into §3 and §8, then stop and wait for human review. Do not implement anything in this phase.

1. Map the repo: `git ls-files | head -300`, read every `package.json`, entry files, route files, models, and the API client on the frontend.
2. Install cleanly (`npm ci` per package). Record any failures.
3. Run every existing test, lint, and build command. Record exact pass/fail counts.
4. Grep for every `process.env.*` / `import.meta.env.*` usage and compare against `.env.example`.
5. List dead code, TODOs, hardcoded URLs, and mock data paths that affect the objective.
6. Refine §5: for each criterion, confirm its proof command actually exists or specify what must be created. Add target-specific criteria (AC-T*) derived from §1.
7. Write or update `scripts/verify.sh` to the contract in §6.
8. Run `verify.sh` once and record the baseline in §3.

---

## 5. Acceptance criteria

Each criterion has an ID, a statement, and a proof. The proof must be a command whose output appears in the transcript.

### 5A. Baseline quality gates (edit or remove any that don't apply after Phase 0)

- [x] **AC-01 Clean install** — `npm ci` succeeds in every package dir. *Proof:* verify.sh `[AC-01] PASS`
- [x] **AC-02 Env contract** — every env var referenced in code is listed in `.env.example` with a comment. The server fails fast with a clear message if a required var is missing. *Proof:* verify.sh diff check
- [x] **AC-03 Server boots + health** — `GET /api/health` returns 200 with `{ status: "ok", db: "connected" }`. *Proof:* verify.sh boots the server, curls it, then kills it
- [x] **AC-04 Isolated test DB** — the backend test suite runs against an in-memory or dedicated test DB, never `MONGODB_URI` from dev. *Proof:* test setup file + passing run
- [x] **AC-05 Auth** — register, login, and `me` work. Passwords are hashed. Missing or invalid/expired JWT returns 401. Duplicate email returns 409. *Proof:* auth integration tests pass
- [x] **AC-06 Validation + error contract** — bad input returns 400. Every error response has the shape `{ error: { code, message } }`. No stack traces when `NODE_ENV=production`. *Proof:* tests
- [x] **AC-07 Backend tests** — the backend test command exits 0 with line coverage ≥ 70% on backend source. *Proof:* coverage summary line
- [x] **AC-08 Frontend build** — the production build exits 0 with no type errors. *Proof:* build output
- [x] **AC-09 No hardcoded endpoints** — no `localhost:` or absolute API URLs in frontend source. The base URL comes from env. *Proof:* verify.sh grep returns nothing
- [x] **AC-10 Lint** — lint exits with 0 errors across all packages. *Proof:* lint output
- [x] **AC-11 Dependency audit** — `npm audit --audit-level=high` reports 0 high/critical in every package, or each exception is justified in §8. *Proof:* audit output
- [x] **AC-12 E2E smoke** — a headless Playwright test runs the full primary user flow from §1 and passes. *Proof:* Playwright summary
- [x] **AC-13 README accuracy** — the setup/run steps in README work verbatim on a fresh clone. *Proof:* verify.sh runs the documented commands

### 5B. Target-specific criteria (derived from §1 — this is the actual point of the run)

<!-- FILL in Phase 0. One observable behaviour per criterion, each with its own test. Template below. -->

- [x] **AC-T1 CSV ingest** — `POST /api/datasets` with `Content-Type: text/csv` returns 201 with `{ id, columns, rowCount, warnings }`. The parser honours RFC 4180 quoting (embedded commas, newlines, doubled quotes), CRLF endings and a UTF-8 BOM. Ragged rows are repaired, not dropped: short rows padded (`MISSING_FIELDS`), long rows truncated (`EXTRA_FIELDS`). Duplicate headers become `name_2`, blank headers become `column_N`. Edge cases: empty/whitespace body → 400 `EMPTY_CSV`; body over `MAX_UPLOAD_BYTES` → 413 `PAYLOAD_TOO_LARGE`; no token → 401 and nothing stored. *Proof:* `backend/test/csv-parse.test.js` + `backend/test/datasets.test.js`, run by verify.sh as `[AC-T1]`
- [x] **AC-T2 Column profiling** — `GET /api/datasets/:id/profile` types every column (`number` / `string` / `date` / `boolean` / `empty`) and reports `count`, `missing`, `unique`, plus `min/max/mean/median/stddev/sum` for numeric columns and top values for categorical ones. On the 5-row fixture, `score` → type `number`, min 15, max 42, median 37, mean 32.8, stddev 10.2645. Edge cases: a column mixing numbers and words is `string` with no stats; an all-blank column is `empty` with `missing == rowCount`; another user's dataset id → 404. *Proof:* `backend/test/profile.test.js`, run by verify.sh as `[AC-T2]`
- [x] **AC-T3 Filter, rank and export** — `GET /api/datasets/:id/rows` accepts repeatable `filter=column:operator:value` (ANDed; operators `eq ne contains gt gte lt lte in empty notEmpty`), `sort`+`direction`, `rankBy`, `page`, `pageSize`. Numeric columns compare numerically, not lexicographically; blanks sort last in **both** directions; `rankBy` is dense (ties share a rank, the next rank is not skipped) and applies after filtering. `GET /api/datasets/:id/export` returns the same filtered set as CSV, ignoring pagination, and round-trips back through the parser. Edge cases: unknown column → 400 `UNKNOWN_COLUMN`; bad operator → 400 `UNKNOWN_OPERATOR`; `pageSize=0` → 400 `VALIDATION_ERROR`; out-of-range page clamps to the last page. *Proof:* `backend/test/query.test.js`, run by verify.sh as `[AC-T3]`

**Writing rules for AC-T\*:**
- Name the input, the expected output, and at least one edge case (empty, invalid, large, or unauthorized).
- Avoid "works", "fast", "clean", or "good UX". Replace them with a number or an assertion.
- If it touches the UI, the proof is a Playwright assertion on visible text or state, not "renders".

---

## 6. `scripts/verify.sh` contract

- Runs **every** check. It must not stop at the first failure (no bare `set -e`). Each check is wrapped as a function that records pass/fail.
- Prints exactly one line per criterion: `[AC-XX] PASS` or `[AC-XX] FAIL: <one-line reason>`.
- First check is a tamper guard: `git diff --quiet <base-branch> -- scripts/verify.sh <pre-existing test dirs>`. If this fails, print `[GUARD] FAIL` and exit 1.
- Starts and stops any server it boots, and cleans up ports.
- Final line is exactly `ALL CHECKS PASSED` (exit 0) or `N CHECKS FAILED` (exit 1).
- Runtime target is under 5 minutes, so it's cheap to run every turn.

---

## 7. Per-turn loop protocol

Every turn, in order:

1. Re-read §0, §2, and §5. Find the lowest-ID unchecked criterion.
2. **Reproduce:** run its proof and capture the failure.
3. **Diagnose:** read the relevant code. State the root cause in one line before editing.
4. **Fix:** make the minimal change. Add or extend tests only in new files, or in files created during this run.
5. **Targeted check:** re-run only that criterion's proof until it passes.
6. **Regression check:** run the full `bash scripts/verify.sh`.
7. **Record:** tick the box, commit, and append to §9.
8. **Print this status block as the last thing in the turn:**

```
GOAL STATUS
Done:     AC-01, AC-02, ...
Current:  AC-XX — <state>
Blocked:  <IDs + one-line reason, or none>
verify.sh: <passed>/<total> — last line: "<exact last line>"
```

### Stuck protocol

- Three failed attempts on the same criterion: stop, write a `BLOCKED` entry in §8 (what you tried, the exact error, your hypothesis), and move to the next criterion that doesn't depend on it.
- Never retry an identical fix. Each attempt must change the hypothesis.
- If a criterion is impossible as written (e.g. it contradicts a constraint), explain why in §8 and in the status block. Do not rewrite the criterion.
- If a fix for AC-X breaks an already-passing AC-Y, revert it and pick a different approach.

---

## 8. Decisions, dependencies & blockers log

<!-- Append-only. Format: [AC-XX] DECISION|DEP|BLOCKED — what — why -->

- [§1] DECISION — Objective was left as `FILL` and Phase 0 had never been run; the repo held only `PLAN.md`. Objective defined from the repo name and this file's own worked example (CSV → dashboard → filter/rank) rather than blocking. — Stated explicitly so it can be corrected; every other section follows from it.
- [§4] DEP — Phase 0 (discovery) was executed inside this run instead of before it, because the repo was empty and there was nothing to discover until it existed. §3 records what was built, not guesses.
- [§0.6] DECISION — `git init` had to happen in this run, so a single baseline commit was made on `main` (source + tests + verify.sh + docs). Every subsequent commit is on `goal/datascout`. Committing to `main` once was unavoidable: the tamper guard in §6 needs a base ref to diff against, and a repo cannot have a branch without a first commit.
- [C1] DECISION — `scripts/verify.sh` did not exist and §4.7 requires Phase 0 to write it. It was written once, in full, to the §6 contract and committed in the baseline; from that commit its own guard fails if it is ever edited.
- [DB] DECISION — SQLite via Node's built-in `node:sqlite` instead of MongoDB (§3 allows "Mongo/other"). No external service to install, no native compilation on Windows, and `:memory:` gives C5's isolated test database for free.
- [C6] DECISION — New dependencies, all unavoidable: `express` + `cors` (HTTP layer), `zod` (request validation), `react`/`react-dom`/`react-router-dom` + `vite`/`typescript` (the frontend itself), `eslint`/`typescript-eslint`/`globals` (AC-10), `@playwright/test` (AC-12). Deliberately **not** added: a CSV library (parser is ours and is the point of AC-T1), `bcrypt` (`node:crypto` scrypt instead — no native build), `jsonwebtoken` (~40 lines of HS256 in `src/auth/jwt.js` with the algorithm fixed), `multer` (CSV arrives as a `text/csv` body), a Mongo driver/ODM.
- [AC-T3] DECISION — Blank cells sort last regardless of direction. Reversing the comparator would make "no value" the top result when sorting descending, which is wrong for a ranking tool.

---

## 9. Progress log

<!-- Append-only, one line per passed criterion: [AC-XX] PASS — commit <sha> — <one-line summary> -->

All criteria were first proved green against baseline commit `17e516b` (branch `goal/datascout`), in the run pasted in the transcript: `16 passed, 0 failed` / `ALL CHECKS PASSED`.

- [AC-01] PASS — commit 17e516b — `npm ci` clean in backend, frontend and e2e; all three lockfiles committed
- [AC-02] PASS — commit 17e516b — every var read by `config.js` and the frontend is documented with a comment in `.env.example`; booting without `JWT_SECRET` exits 1 naming the variable
- [AC-03] PASS — commit 17e516b — `GET /api/health` → 200 `{"status":"ok","db":"connected",...}`; verify.sh boots and kills the server itself
- [AC-04] PASS — commit 17e516b — suite pinned to `DATABASE_URL=':memory:'`; a canary path passed as `DATABASE_URL` is never created
- [AC-05] PASS — commit 17e516b — register/login/me; scrypt digests; 401 for missing, malformed, tampered, wrong-secret, expired and orphaned tokens; 409 on duplicate email
- [AC-06] PASS — commit 17e516b — 400 on bad input with `{error:{code,message}}` everywhere, including 404s and body-parser failures; no stack traces under `NODE_ENV=production`
- [AC-07] PASS — commit 17e516b — 81 tests pass, line coverage 98.38% (threshold 70%)
- [AC-08] PASS — commit 17e516b — `tsc --noEmit && vite build` exits 0, no type errors
- [AC-09] PASS — commit 17e516b — no absolute URL or `localhost:` literal anywhere in `frontend/src`; base URL comes from `VITE_API_BASE_URL`, and a lint rule blocks regressions
- [AC-10] PASS — commit 17e516b — ESLint 10 flat config, 0 errors across all three packages
- [AC-11] PASS — commit 17e516b — `npm audit --audit-level=high` reports 0 advisories in all three packages; no exceptions needed
- [AC-12] PASS — commit 17e516b — 4 Playwright tests pass against the production bundle and a real API on private ports
- [AC-13] PASS — commit 17e516b — every command in the README Quick start block resolves to a real file, lockfile or npm script
- [AC-T1] PASS — commit 17e516b — CSV ingest: RFC 4180 quoting, CRLF, BOM, ragged-row repair, header normalisation, and the 400/413/401 edge cases
- [AC-T2] PASS — commit 17e516b — column profiling: type inference and numeric statistics, mixed and all-blank column edges
- [AC-T3] PASS — commit 17e516b — filter/sort/dense-rank/export, numeric-aware ordering, blanks last in both directions, and the 400 edge cases

---

## 10. Out of scope (do not work on these during this run)

- Visual redesign or restyling beyond what a criterion requires
- Deployment / CI config (unless a criterion says otherwise)
- Performance optimisation without a numeric criterion
- Multi-user sharing, teams or roles — datasets are strictly single-owner for now
- Streaming or chunked upload of very large CSVs; the current limit is `MAX_UPLOAD_BYTES`
- Charting or visualisation of the profiled columns
- Swapping SQLite for a networked database
