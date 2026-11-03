#!/usr/bin/env bash
# verify-bugs.sh [bug-id ...]
#
# For every bug (default: all of bench/bugs/B*):
#   1. the patch applies cleanly to the clean tree,
#   2. the trigger run against the patched tree exits non-zero and its output
#      contains truth.json's error_signature,
#   3. the patch reverse-applies, leaving the tree byte-identical.
# Then, on the clean tree, the full Jest suite must be green.
#
# Run from anywhere; needs apps/mqtt-sample/node_modules (npm ci) and git.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
APP=$ROOT/apps/mqtt-sample
cd "$ROOT"

if [ $# -gt 0 ]; then BUGS=("$@"); else BUGS=(); for d in bench/bugs/B*/; do BUGS+=("$(basename "$d")"); done; fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail=0
pass=0

note() { printf '%s\n' "$*"; }

# content checksum of the app sources (mtime-independent) for comparison after revert
fingerprint() {
  find apps/mqtt-sample -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/coverage/*' -print0 \
    | sort -z | xargs -0 sha256sum
}
fingerprint >"$TMP/clean.sum"

for bug in "${BUGS[@]}"; do
  dir=bench/bugs/$bug
  if [ ! -f "$dir/bug.patch" ] || [ ! -f "$dir/truth.json" ] || [ ! -f "$dir/trigger.ts" ]; then
    note "FAIL $bug: missing bug.patch / truth.json / trigger.ts"; fail=$((fail + 1)); continue
  fi
  sig=$(node -p "require('$ROOT/$dir/truth.json').error_signature")

  if ! git apply --check "$dir/bug.patch" 2>"$TMP/apply.err"; then
    note "FAIL $bug: patch does not apply: $(cat "$TMP/apply.err")"; fail=$((fail + 1)); continue
  fi
  git apply "$dir/bug.patch"

  ( cd "$APP" && npx tsx "../../$dir/trigger.ts" ) >"$TMP/$bug.log" 2>&1
  code=$?

  if ! git apply -R "$dir/bug.patch"; then
    note "FAIL $bug: patch does not revert — tree is dirty, fix by hand"; fail=$((fail + 1)); continue
  fi
  fingerprint >"$TMP/after.sum"
  if ! cmp -s "$TMP/clean.sum" "$TMP/after.sum"; then
    note "FAIL $bug: tree differs from clean after revert"; fail=$((fail + 1)); continue
  fi

  if [ "$code" -eq 0 ]; then
    note "FAIL $bug: trigger exited 0 with the bug applied"; fail=$((fail + 1)); continue
  fi
  if ! grep -qF -- "$sig" "$TMP/$bug.log"; then
    note "FAIL $bug: signature not found in trigger output: $sig"
    sed 's/^/    /' "$TMP/$bug.log" | head -40
    fail=$((fail + 1)); continue
  fi
  note "ok   $bug  exit=$code  $sig"
  pass=$((pass + 1))
done

note "--- clean tree: triggers must exit 0 ---"
for bug in "${BUGS[@]}"; do
  dir=bench/bugs/$bug
  [ -f "$dir/trigger.ts" ] || continue
  if ( cd "$APP" && npx tsx "../../$dir/trigger.ts" ) >"$TMP/$bug.clean.log" 2>&1; then
    note "ok   $bug  clean trigger exit=0"
  else
    note "FAIL $bug: trigger exited non-zero on the clean tree"; fail=$((fail + 1))
  fi
done

note "--- clean tree: full suite ---"
if ( cd "$APP" && npx jest --detectOpenHandles ) >"$TMP/jest.log" 2>&1; then
  note "ok   $(grep -E '^Tests:' "$TMP/jest.log")"
else
  note "FAIL clean suite is red:"; tail -30 "$TMP/jest.log"; fail=$((fail + 1))
fi

note "--- summary: $pass bug(s) verified, $fail failure(s) ---"
[ "$fail" -eq 0 ]
