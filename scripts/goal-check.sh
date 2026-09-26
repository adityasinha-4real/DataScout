#!/usr/bin/env bash
# Proves the finish line has not moved since a base commit: scripts/verify.sh
# (which holds the 95% coverage floor) and the eight tamper-guarded test files
# must be byte-identical to the base, both as committed and in the working
# tree.
#
# `git diff` on its own is not proof: a path that exists nowhere diffs as
# empty and exits 0, so a typo or a deleted file would pass silently. Every
# path is therefore required to exist at the base, at HEAD and on disk before
# the diff is trusted, and any missing one fails the check by name.
#
# Usage: bash scripts/goal-check.sh [base] [path...]
#   base   defaults to bbc0b61
#   path   defaults to the guarded set below

BASE="${1:-bbc0b61}"
shift $(( $# > 0 ? 1 : 0 ))

if [ $# -gt 0 ]; then
  PATHS=("$@")
else
  PATHS=(
    scripts/verify.sh
    backend/test/helpers.js
    backend/test/app.test.js
    backend/test/auth.test.js
    backend/test/csv-parse.test.js
    backend/test/datasets.test.js
    backend/test/profile.test.js
    backend/test/query.test.js
    e2e/tests/smoke.spec.ts
  )
fi

cd "$(git rev-parse --show-toplevel)" || exit 1

if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  echo "GOAL-CHECK FAIL: base '$BASE' is not a commit"
  exit 1
fi

MISSING=0
for path in "${PATHS[@]}"; do
  git cat-file -e "$BASE:$path" 2>/dev/null ||
    { echo "GOAL-CHECK FAIL: missing at $BASE: $path"; MISSING=1; }
  git cat-file -e "HEAD:$path" 2>/dev/null ||
    { echo "GOAL-CHECK FAIL: missing at HEAD: $path"; MISSING=1; }
  [ -f "$path" ] ||
    { echo "GOAL-CHECK FAIL: missing in working tree: $path"; MISSING=1; }
done
[ "$MISSING" -eq 0 ] || exit 1

# Committed history and uncommitted edits are checked separately, so neither
# can hide behind the other.
FAILED=0
if ! git diff --quiet "$BASE" HEAD -- "${PATHS[@]}"; then
  echo "GOAL-CHECK FAIL: committed changes since $BASE:"
  git diff --stat "$BASE" HEAD -- "${PATHS[@]}"
  FAILED=1
fi
if ! git diff --quiet HEAD -- "${PATHS[@]}"; then
  echo "GOAL-CHECK FAIL: uncommitted changes:"
  git diff --stat HEAD -- "${PATHS[@]}"
  FAILED=1
fi
[ "$FAILED" -eq 0 ] || exit 1

echo "GOAL-CHECK PASS: ${#PATHS[@]} paths present at $BASE, HEAD and on disk; no diff since $BASE"
