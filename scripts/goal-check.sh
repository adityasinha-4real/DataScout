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

# Owner-approved edits, one per entry: path, line number, the exact line at
# the base, and the exact replacement. The expected content of that path is
# its base content with that one line swapped; nothing else may differ. The
# base line is checked too, so an approval cannot silently drift onto a
# different line. Approved in the iteration-2 close-out: the TTL default.
APPROVED=(
  "backend/test/app.test.js|87|  assert.equal(config.jwtExpiresIn, 3600);|  assert.equal(config.jwtExpiresIn, 900);"
)

approval_for() {
  local entry
  for entry in "${APPROVED[@]}"; do
    [ "${entry%%|*}" = "$1" ] && { echo "$entry"; return; }
  done
}

# The blob a path should hold: base content, plus its approved edit if any.
expected_blob() {
  local path="$1" entry line old new
  entry="$(approval_for "$path")"
  if [ -z "$entry" ]; then
    git rev-parse "$BASE:$path"
    return
  fi
  IFS='|' read -r _ line old new <<<"$entry"
  git show "$BASE:$path" |
    awk -v n="$line" -v old="$old" -v new="$new" '
      NR == n { if ($0 != old) exit 3; print new; next }
      { print }' |
    git hash-object --stdin
  # awk exits 3 when the base line is not the approved "old" text.
  [ "${PIPESTATUS[1]}" -eq 0 ] || return 1
}

# Committed content (HEAD) and the working tree are checked separately, so
# neither can hide behind the other. Blob hashes are compared, so line-ending
# conversion on checkout cannot cause a false result.
FAILED=0
for path in "${PATHS[@]}"; do
  if ! expected="$(expected_blob "$path")"; then
    echo "GOAL-CHECK FAIL: $path line no longer matches its approval at $BASE"
    FAILED=1
    continue
  fi
  label="no diff"
  [ -n "$(approval_for "$path")" ] && label="only the approved edit"
  if [ "$(git rev-parse "HEAD:$path")" != "$expected" ]; then
    echo "GOAL-CHECK FAIL: committed $path is not $BASE plus its approved edits"
    git diff "$BASE" HEAD -- "$path" | head -n 40
    FAILED=1
  elif [ "$(git hash-object -- "$path")" != "$expected" ]; then
    echo "GOAL-CHECK FAIL: working-tree $path is not $BASE plus its approved edits"
    git diff HEAD -- "$path" | head -n 40
    FAILED=1
  else
    echo "  ok  $path ($label)"
  fi
done
[ "$FAILED" -eq 0 ] || exit 1

echo "GOAL-CHECK PASS: ${#PATHS[@]} paths present at $BASE, HEAD and on disk; nothing differs from $BASE except approved edits (${#APPROVED[@]})"
