#!/usr/bin/env bash
# DataScout acceptance gate.
#
# Runs every criterion in PLAN.md section 5, prints exactly one
# "[AC-XX] PASS" / "[AC-XX] FAIL: reason" line each, and never stops early --
# a failing check must not hide the ones after it. Final line is either
# "ALL CHECKS PASSED" (exit 0) or "N CHECKS FAILED" (exit 1).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

TMP="$ROOT/.verify-tmp"
rm -rf "$TMP"
mkdir -p "$TMP"

PASSED=0
FAILED=0
API_PORT="${VERIFY_API_PORT:-4412}"
SERVER_PID=""

pass() {
  echo "[$1] PASS"
  PASSED=$((PASSED + 1))
}

fail() {
  echo "[$1] FAIL: $2"
  FAILED=$((FAILED + 1))
}

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

PKG_DIRS="backend frontend e2e"

# ---------------------------------------------------------------- tamper guard
# The finish line may not move: this file and every pre-existing test
# directory must be byte-identical to the base branch.
BASE_REF="${VERIFY_BASE_REF:-main}"
# Named file by file rather than by directory. C1 protects the tests that
# existed before the run, and a directory-level diff also rejects *adding* a
# test, which would make AC-T4..AC-T8 unprovable. Listing the files keeps every
# pre-existing test frozen -- a diff also fires on deletion -- while leaving
# room for the new ones. Nothing is removed from the guard.
GUARDED="scripts/verify.sh
  backend/test/helpers.js
  backend/test/app.test.js
  backend/test/auth.test.js
  backend/test/csv-parse.test.js
  backend/test/datasets.test.js
  backend/test/profile.test.js
  backend/test/query.test.js
  e2e/tests/smoke.spec.ts"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[GUARD] FAIL: not a git repository, cannot verify the checks are untampered"
  echo "1 CHECKS FAILED"
  exit 1
fi
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
  echo "[GUARD] FAIL: base ref '$BASE_REF' does not exist"
  echo "1 CHECKS FAILED"
  exit 1
fi
# shellcheck disable=SC2086
if ! git diff --quiet "$BASE_REF" -- $GUARDED; then
  echo "[GUARD] FAIL: verify.sh or a protected test directory differs from $BASE_REF"
  # shellcheck disable=SC2086
  git diff --stat "$BASE_REF" -- $GUARDED
  echo "1 CHECKS FAILED"
  exit 1
fi
echo "[GUARD] PASS"

# ------------------------------------------------------------------ AC-01 ci
AC01_OK=1
for dir in $PKG_DIRS; do
  if [ ! -f "$dir/package-lock.json" ]; then
    fail "AC-01" "$dir has no package-lock.json, so npm ci cannot run"
    AC01_OK=0
    break
  fi
  if ! (cd "$dir" && npm ci --no-audit --no-fund) >"$TMP/ci-$dir.log" 2>&1; then
    fail "AC-01" "npm ci failed in $dir (see .verify-tmp/ci-$dir.log)"
    AC01_OK=0
    break
  fi
done
[ "$AC01_OK" = 1 ] && pass "AC-01"

# -------------------------------------------------------------- AC-02 env
# Every variable the code reads must be documented, and a required variable
# missing must stop the server rather than surface later as a 500.
{
  grep -hoE "(required|optional|integer)\('[A-Z0-9_]+'" backend/src/config.js |
    grep -oE "'[A-Z0-9_]+'" | tr -d "'"
  grep -rhoE "process\.env\.[A-Z0-9_]+" backend/src |
    sed 's/process\.env\.//'
  grep -rhoE "import\.meta\.env\.VITE_[A-Z0-9_]+" frontend/src |
    sed 's/import\.meta\.env\.//'
} 2>/dev/null | sort -u >"$TMP/env-used.txt"

MISSING_VARS=""
UNCOMMENTED_VARS=""
while read -r var; do
  [ -z "$var" ] && continue
  if ! grep -qE "^${var}=" .env.example; then
    MISSING_VARS="$MISSING_VARS $var"
    continue
  fi
  # The line directly above the assignment must be a comment explaining it.
  if ! grep -B1 -E "^${var}=" .env.example | head -n1 | grep -q '^#'; then
    UNCOMMENTED_VARS="$UNCOMMENTED_VARS $var"
  fi
done <"$TMP/env-used.txt"

FAILFAST_OUT="$(cd backend && env -u JWT_SECRET NODE_ENV=test DATABASE_URL=':memory:' \
  node --disable-warning=ExperimentalWarning src/server.js 2>&1)"
FAILFAST_CODE=$?

if [ -n "$MISSING_VARS" ]; then
  fail "AC-02" "not documented in .env.example:$MISSING_VARS"
elif [ -n "$UNCOMMENTED_VARS" ]; then
  fail "AC-02" "documented without an explanatory comment:$UNCOMMENTED_VARS"
elif [ "$FAILFAST_CODE" -eq 0 ]; then
  fail "AC-02" "the server booted with no JWT_SECRET instead of failing fast"
elif ! echo "$FAILFAST_OUT" | grep -qi "JWT_SECRET"; then
  fail "AC-02" "fail-fast message does not name the missing variable"
else
  pass "AC-02"
fi

# ------------------------------------------------------------- AC-03 health
(cd backend && NODE_ENV=test PORT="$API_PORT" DATABASE_URL=':memory:' \
  JWT_SECRET='verify-script-secret-value-at-least-32-chars' \
  node --disable-warning=ExperimentalWarning src/server.js >"$TMP/server.log" 2>&1) &
SERVER_PID=$!

HEALTH_BODY=""
HEALTH_CODE=""
for _ in $(seq 1 40); do
  HEALTH_BODY="$(curl -fsS "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null)"
  if [ -n "$HEALTH_BODY" ]; then
    HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null)"
    break
  fi
  sleep 0.5
done

if [ "$HEALTH_CODE" != "200" ]; then
  fail "AC-03" "GET /api/health did not return 200 (got '${HEALTH_CODE:-no response}')"
elif ! echo "$HEALTH_BODY" | grep -q '"status":"ok"'; then
  fail "AC-03" "health body missing status \"ok\": $HEALTH_BODY"
elif ! echo "$HEALTH_BODY" | grep -q '"db":"connected"'; then
  fail "AC-03" "health body missing db \"connected\": $HEALTH_BODY"
else
  pass "AC-03"
fi

kill "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null
SERVER_PID=""

# -------------------------------------------------------- AC-04 isolated db
# A canary path proves isolation: if any test touched the configured database
# instead of an in-memory one, this file would appear.
CANARY="$TMP/canary.db"
rm -f "$CANARY"
(cd backend && DATABASE_URL="$CANARY" npm test) >"$TMP/test-isolation.log" 2>&1
ISOLATION_CODE=$?

if [ "$ISOLATION_CODE" -ne 0 ]; then
  fail "AC-04" "backend tests failed while checking DB isolation"
elif [ -f "$CANARY" ]; then
  fail "AC-04" "tests wrote to the configured DATABASE_URL instead of an in-memory DB"
elif ! grep -q "DATABASE_URL: ':memory:'" backend/test/helpers.js; then
  fail "AC-04" "the test harness does not pin DATABASE_URL to :memory:"
else
  pass "AC-04"
fi

# ------------------------------------------------------------------ AC-05 auth
if (cd backend && node --disable-warning=ExperimentalWarning --test \
  "test/auth.test.js") >"$TMP/test-auth.log" 2>&1; then
  pass "AC-05"
else
  fail "AC-05" "auth integration tests failed (see .verify-tmp/test-auth.log)"
fi

# ------------------------------------------------- AC-06 validation + errors
if (cd backend && node --disable-warning=ExperimentalWarning --test \
  "test/app.test.js") >"$TMP/test-app.log" 2>&1; then
  pass "AC-06"
else
  fail "AC-06" "error-contract tests failed (see .verify-tmp/test-app.log)"
fi

# -------------------------------------------------- AC-07 tests + coverage
(cd backend && npm test) >"$TMP/test-full.log" 2>&1
TEST_CODE=$?
COVERAGE_LINE="$(grep 'all files' "$TMP/test-full.log" | tail -n1)"
COVERAGE="$(echo "$COVERAGE_LINE" | awk -F'|' '{gsub(/ /,"",$2); print $2}')"

if [ "$TEST_CODE" -ne 0 ]; then
  fail "AC-07" "backend test command exited $TEST_CODE"
elif [ -z "$COVERAGE" ]; then
  fail "AC-07" "no coverage summary found in the test output"
elif awk -v c="$COVERAGE" 'BEGIN { exit !(c + 0 >= 95) }'; then
  echo "         line coverage ${COVERAGE}% (threshold 95%)"
  pass "AC-07"
else
  fail "AC-07" "line coverage ${COVERAGE}% is below the 95% threshold"
fi

# ------------------------------------------------------------ AC-08 fe build
if (cd frontend && VITE_API_BASE_URL="http://127.0.0.1:$API_PORT" npm run build) \
  >"$TMP/build.log" 2>&1; then
  pass "AC-08"
else
  fail "AC-08" "frontend production build failed (see .verify-tmp/build.log)"
fi

# ------------------------------------------------- AC-09 no hardcoded hosts
HARDCODED="$(grep -rnE "https?://|localhost:[0-9]+" frontend/src 2>/dev/null)"
if [ -n "$HARDCODED" ]; then
  fail "AC-09" "absolute URLs in frontend source: $(echo "$HARDCODED" | head -n3 | tr '\n' ' ')"
elif ! grep -rq "import.meta.env.VITE_API_BASE_URL" frontend/src; then
  fail "AC-09" "frontend never reads VITE_API_BASE_URL"
else
  pass "AC-09"
fi

# ------------------------------------------------------------------ AC-10 lint
LINT_FAILURES=""
for dir in $PKG_DIRS; do
  if ! (cd "$dir" && npm run lint) >"$TMP/lint-$dir.log" 2>&1; then
    LINT_FAILURES="$LINT_FAILURES $dir"
  fi
done
if [ -n "$LINT_FAILURES" ]; then
  fail "AC-10" "lint reported errors in:$LINT_FAILURES"
else
  pass "AC-10"
fi

# ----------------------------------------------------------------- AC-11 audit
AUDIT_FAILURES=""
for dir in $PKG_DIRS; do
  if ! (cd "$dir" && npm audit --audit-level=high) >"$TMP/audit-$dir.log" 2>&1; then
    AUDIT_FAILURES="$AUDIT_FAILURES $dir"
  fi
done
if [ -n "$AUDIT_FAILURES" ]; then
  fail "AC-11" "high or critical advisories in:$AUDIT_FAILURES"
else
  pass "AC-11"
fi

# ------------------------------------------------------------------- AC-12 e2e
if (cd e2e && npm test) >"$TMP/e2e.log" 2>&1; then
  echo "         $(grep -E '[0-9]+ passed' "$TMP/e2e.log" | tail -n1 | sed 's/^ *//')"
  pass "AC-12"
else
  fail "AC-12" "Playwright smoke suite failed (see .verify-tmp/e2e.log)"
fi

# ---------------------------------------------------------------- AC-13 readme
# Every command in the README's Quick start block must actually be runnable.
README_ERRORS=""
if [ ! -f README.md ]; then
  README_ERRORS=" README.md is missing"
else
  awk '/^## Quick start/{flag=1} flag && /^```/{c++} flag && c==1 && !/^```/{print} c==2{flag=0;c=0}' \
    README.md >"$TMP/readme-cmds.txt"

  if [ ! -s "$TMP/readme-cmds.txt" ]; then
    README_ERRORS=" no Quick start command block found"
  fi

  while read -r line; do
    case "$line" in
      '' | '#'*) continue ;;
      'cp '*)
        src="$(echo "$line" | awk '{print $2}')"
        [ -f "$src" ] || README_ERRORS="$README_ERRORS missing-file:$src"
        ;;
      'npm ci'*)
        dir="$(echo "$line" | sed -n 's/.*--prefix \([^ ]*\).*/\1/p')"
        dir="${dir:-.}"
        [ -f "$dir/package-lock.json" ] ||
          README_ERRORS="$README_ERRORS no-lockfile:$dir"
        ;;
      'npm run '*)
        script="$(echo "$line" | sed -n 's/^npm run \([^ ]*\).*/\1/p')"
        dir="$(echo "$line" | sed -n 's/.*--prefix \([^ ]*\).*/\1/p')"
        dir="${dir:-.}"
        if ! node -e "
          const pkg = require('./$dir/package.json');
          process.exit(pkg.scripts && pkg.scripts['$script'] ? 0 : 1);
        " 2>/dev/null; then
          README_ERRORS="$README_ERRORS no-script:$dir/$script"
        fi
        ;;
    esac
  done <"$TMP/readme-cmds.txt"
fi

if [ -n "$README_ERRORS" ]; then
  fail "AC-13" "README quick start is not runnable:$README_ERRORS"
else
  pass "AC-13"
fi

# ------------------------------------------- AC-T1/T2/T3 target behaviours
run_unit() {
  local id="$1"
  local label="$2"
  shift 2
  if (cd backend && node --disable-warning=ExperimentalWarning --test "$@") \
    >"$TMP/test-$id.log" 2>&1; then
    pass "$id"
  else
    fail "$id" "$label (see .verify-tmp/test-$id.log)"
  fi
}

run_unit "AC-T1" "CSV ingest and parsing behaviour failed" \
  "test/csv-parse.test.js" "test/datasets.test.js"
run_unit "AC-T2" "column profiling behaviour failed" "test/profile.test.js"
run_unit "AC-T3" "filter/sort/rank/export behaviour failed" "test/query.test.js"

# ------------------------------------------ AC-T4..AC-T8 iteration-2 criteria
# Added under the one-time C1a exception in PLAN.md section 2.

# Runs a backend test file with every model credential stripped from the
# environment. A suite that passes here provably never reached the LLM API (C9).
run_offline_unit() {
  local id="$1"
  shift
  (cd backend && env -u ANTHROPIC_API_KEY -u LLM_MODEL \
    node --disable-warning=ExperimentalWarning --test "$@") \
    >"$TMP/test-$id.log" 2>&1
}

# The UI halves of AC-T4 and AC-T5 run inside the AC-12 Playwright suite, so
# this only has to confirm the spec was actually collected rather than skipped.
e2e_ran() {
  [ -f "$TMP/e2e.log" ] && grep -q "$1" "$TMP/e2e.log"
}

# ----------------------------------------------------- AC-T4 ask (NL query)
T4_ERR=""
[ -d backend/src/llm ] || T4_ERR="$T4_ERR no-provider-interface:backend/src/llm"
if [ ! -f backend/test/ask.test.js ]; then
  T4_ERR="$T4_ERR no-test:backend/test/ask.test.js"
elif ! run_offline_unit "AC-T4" "test/ask.test.js"; then
  T4_ERR="$T4_ERR tests-failed(see .verify-tmp/test-AC-T4.log)"
fi
if [ ! -f e2e/tests/ask.spec.ts ]; then
  T4_ERR="$T4_ERR no-e2e-spec:e2e/tests/ask.spec.ts"
elif ! e2e_ran "ask\.spec\.ts"; then
  T4_ERR="$T4_ERR e2e-spec-never-ran"
fi
# C9: model output is data. It is never executed, and the provider call may
# only exist behind the src/llm interface.
EXECUTES="$(grep -rlE "\beval\(|new Function\(|child_process" backend/src 2>/dev/null)"
if [ -n "$EXECUTES" ]; then
  T4_ERR="$T4_ERR executes-untrusted-input:$(echo "$EXECUTES" | tr '\n' ',')"
fi
STRAY_LLM="$(grep -rlE "api\.anthropic\.com" backend/src 2>/dev/null |
  grep -v '^backend/src/llm/')"
if [ -n "$STRAY_LLM" ]; then
  T4_ERR="$T4_ERR provider-call-outside-src/llm:$(echo "$STRAY_LLM" | tr '\n' ',')"
fi
if [ -n "$T4_ERR" ]; then
  fail "AC-T4" "natural-language query:$T4_ERR"
else
  pass "AC-T4"
fi

# --------------------------------------------------- AC-T5 outlier detection
T5_ERR=""
if [ ! -f backend/test/anomalies.test.js ]; then
  T5_ERR="$T5_ERR no-test:backend/test/anomalies.test.js"
elif ! run_offline_unit "AC-T5" "test/anomalies.test.js"; then
  T5_ERR="$T5_ERR tests-failed(see .verify-tmp/test-AC-T5.log)"
fi
if [ ! -f e2e/tests/anomalies.spec.ts ]; then
  T5_ERR="$T5_ERR no-e2e-spec:e2e/tests/anomalies.spec.ts"
elif ! e2e_ran "anomalies\.spec\.ts"; then
  T5_ERR="$T5_ERR e2e-spec-never-ran"
fi
grep -rq "anomalies" backend/src/routes ||
  T5_ERR="$T5_ERR no-anomalies-route"
if [ -n "$T5_ERR" ]; then
  fail "AC-T5" "outlier detection:$T5_ERR"
else
  pass "AC-T5"
fi

# -------------------------------------------------------- AC-T6 cookie auth
T6_ERR=""
if [ ! -f backend/test/cookie-auth.test.js ]; then
  T6_ERR="$T6_ERR no-test:backend/test/cookie-auth.test.js"
elif ! run_offline_unit "AC-T6" "test/cookie-auth.test.js"; then
  T6_ERR="$T6_ERR tests-failed(see .verify-tmp/test-AC-T6.log)"
fi
# The browser must not keep the token anywhere a script can read it.
WEB_STORAGE="$(grep -rnE "localStorage|sessionStorage" frontend/src 2>/dev/null)"
if [ -n "$WEB_STORAGE" ]; then
  T6_ERR="$T6_ERR web-storage-used:$(echo "$WEB_STORAGE" | head -n1 | cut -c1-60)"
fi
grep -rqE "credentials:[[:space:]]*['\"]include['\"]" frontend/src ||
  T6_ERR="$T6_ERR frontend-does-not-send-credentials"
grep -riq "httponly" backend/src || T6_ERR="$T6_ERR cookie-not-httponly"
grep -riq "samesite=lax" backend/src || T6_ERR="$T6_ERR cookie-not-samesite-lax"
# A credentialed CORS response may never be a wildcard.
if grep -rnE "['\"]Access-Control-Allow-Origin['\"][^)]*\*|origin:[[:space:]]*['\"]\*['\"]" \
  backend/src >/dev/null 2>&1; then
  T6_ERR="$T6_ERR wildcard-cors-with-credentials"
fi
if [ -n "$T6_ERR" ]; then
  fail "AC-T6" "cookie auth:$T6_ERR"
else
  pass "AC-T6"
fi

# ---------------------------------------------------- AC-T7 auth rate limit
T7_ERR=""
if [ ! -f backend/test/rate-limit.test.js ]; then
  T7_ERR="$T7_ERR no-test:backend/test/rate-limit.test.js"
elif ! run_offline_unit "AC-T7" "test/rate-limit.test.js"; then
  T7_ERR="$T7_ERR tests-failed(see .verify-tmp/test-AC-T7.log)"
fi
grep -q "AUTH_RATE_LIMIT_PER_MIN" backend/src/config.js ||
  T7_ERR="$T7_ERR limit-not-configurable"
grep -qE "^AUTH_RATE_LIMIT_PER_MIN=" .env.example ||
  T7_ERR="$T7_ERR not-documented-in-.env.example"
if [ -n "$T7_ERR" ]; then
  fail "AC-T7" "auth rate limit:$T7_ERR"
else
  pass "AC-T7"
fi

# ------------------------------------------- AC-T8 frontend component tests
T8_ERR=""
if ! node -e "
  const pkg = require('./frontend/package.json');
  process.exit(pkg.scripts && pkg.scripts.test ? 0 : 1);
" 2>/dev/null; then
  T8_ERR="$T8_ERR no-test-script-in-frontend"
elif ! (cd frontend && npm test) >"$TMP/test-frontend.log" 2>&1; then
  T8_ERR="$T8_ERR vitest-failed(see .verify-tmp/test-frontend.log)"
fi
# One file per surface named in the criterion, and each must drive a real user
# event rather than assert that the component merely rendered.
for surface in upload filter ask anomal; do
  SURFACE_FILE="$(find frontend/src -iname "*${surface}*.test.tsx" 2>/dev/null | head -n1)"
  if [ -z "$SURFACE_FILE" ]; then
    T8_ERR="$T8_ERR no-test-file-for:$surface"
  elif ! grep -qE "userEvent|fireEvent" "$SURFACE_FILE"; then
    T8_ERR="$T8_ERR no-user-interaction-in:$SURFACE_FILE"
  fi
done
if [ -n "$T8_ERR" ]; then
  fail "AC-T8" "frontend component tests:$T8_ERR"
else
  pass "AC-T8"
fi

# ---------------------------------------------------------------------- result
echo
echo "$PASSED passed, $FAILED failed"
if [ "$FAILED" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILED CHECKS FAILED"
exit 1
