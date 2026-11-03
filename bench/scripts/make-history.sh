#!/usr/bin/env bash
# make-history.sh <bug-id> <out-dir> [--link]
#
# Materialises a throwaway git repository at <out-dir> for `git bisect`:
#
#   initial telemetry-hub          (tag: good)
#   5 noise commits                 (docs / comments / test naming — suite stays green)
#   <bug commit>                    (bench/bugs/<bug-id>/bug.patch, innocuous message)
#   3 noise commits
#   HEAD                            (tag: bad)
#
# Commit dates and author are fixed so the history is reproducible. The last
# line printed on stdout is the SHA of the bug commit.
#
# node_modules are NOT copied. Either run `npm ci` in <out-dir>/apps/mqtt-sample
# or pass --link to symlink this repo's apps/mqtt-sample/node_modules.
#
# The bug's trigger (and the shared harness) are copied to <out-dir>/bench/bugs/
# and kept untracked (via .git/info/exclude) so every checkout can run it:
#
#   cd <out-dir> && git bisect start bad good && \
#   git bisect run sh -c 'cd apps/mqtt-sample && npx tsx ../../bench/bugs/<bug-id>/trigger.ts >/dev/null 2>&1'
set -euo pipefail

BUG=${1:?usage: make-history.sh <bug-id> <out-dir> [--link]}
OUT=${2:?usage: make-history.sh <bug-id> <out-dir> [--link]}
LINK=${3:-}

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
APP=$ROOT/apps/mqtt-sample
BUGDIR=$ROOT/bench/bugs/$BUG
[ -f "$BUGDIR/bug.patch" ] || { echo "no such bug: $BUG" >&2; exit 2; }

case "$BUG" in
  B01) BUG_MSG="simplify unit normalisation in telemetry parser" ;;
  B02) BUG_MSG="include never-seen devices in the offline sweep" ;;
  B03) BUG_MSG="simplify topic matcher regex generation" ;;
  B04) BUG_MSG="harden \$SYS handling in topic matcher" ;;
  B05) BUG_MSG="end mqtt connection before draining handlers on close" ;;
  B06) BUG_MSG="do not block startup on the inventory service" ;;
  B07) BUG_MSG="fix p95 rounding in window aggregates" ;;
  B08) BUG_MSG="tighten telemetry range validation" ;;
  *)   BUG_MSG="tighten payload handling" ;;
esac

rm -rf "$OUT"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

# --- copy the clean app (no node_modules/dist/coverage) ------------------------
( cd "$ROOT" && tar --exclude=node_modules --exclude=dist --exclude=coverage -cf - apps/mqtt-sample ) | ( cd "$OUT" && tar -xf - )
cp "$ROOT/LICENSE" "$OUT/LICENSE"
cp "$ROOT/.gitignore" "$OUT/.gitignore"

# --- untracked trigger so bisect can run it at every revision ------------------
mkdir -p "$OUT/bench/bugs/$BUG" "$OUT/bench/bugs/_shared"
cp "$BUGDIR/trigger.ts" "$OUT/bench/bugs/$BUG/trigger.ts"
cp "$ROOT/bench/bugs/_shared/harness.ts" "$OUT/bench/bugs/_shared/harness.ts"

if [ "$LINK" = "--link" ] && [ -d "$APP/node_modules" ]; then
  ln -s "$APP/node_modules" "$OUT/apps/mqtt-sample/node_modules"
fi

cd "$OUT"
git init -q -b main
git config user.name "Telemetry Hub Dev"
git config user.email "dev@example.com"
git config commit.gpgsign false
echo "bench/" >> .git/info/exclude

EPOCH=1767225600 # 2026-01-01T00:00:00Z
N=0
commit() {
  N=$((N + 1))
  local when="$((EPOCH + N * 3600)) +0000"
  git add -A
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" git commit -q -m "$1"
}

# exact-string replacement that fails loudly if the anchor is missing
edit() {
  node -e '
    const fs = require("fs");
    const [file, from, to] = process.argv.slice(1);
    const src = fs.readFileSync(file, "utf8");
    if (!src.includes(from)) { console.error("anchor not found in " + file + ": " + from); process.exit(1); }
    fs.writeFileSync(file, src.replace(from, to));
  ' "$@"
}

commit "initial telemetry-hub"
git tag good

# --- noise before the bug -----------------------------------------------------
edit apps/mqtt-sample/README.md \
  "Alerts are published to \`alerts/{deviceId}\`." \
  "Alerts are published to \`alerts/{deviceId}\` (QoS 1, not retained)."
commit "docs: note alert QoS in README"

edit apps/mqtt-sample/src/logger.ts \
  " * Minimal structured logger. One JSON object per line, errors followed by" \
  " * Minimal structured logger (no external dependency). One JSON object per line, errors followed by"
commit "logger: clarify header comment"

edit apps/mqtt-sample/test/alert-rule.spec.ts \
  "  describe('conditions', () => {" \
  "  describe('threshold conditions', () => {"
commit "test: name the alert-rule condition block more precisely"

edit apps/mqtt-sample/src/telemetry/reading.ts \
  "  value: number;
  unit: string;" \
  "  value: number;
  /** Normalised unit symbol, e.g. C, %, hPa; empty when unknown. */
  unit: string;"
commit "reading: document the unit field"

edit apps/mqtt-sample/package.json \
  "\"description\": \"Small NestJS + MQTT IoT telemetry hub used as a benchmark target (in-process aedes broker).\"" \
  "\"description\": \"Small NestJS + MQTT IoT telemetry hub (in-process aedes broker, no external services).\""
commit "chore: tweak package description"

# --- the bug ------------------------------------------------------------------
git apply "$BUGDIR/bug.patch"
commit "$BUG_MSG"
BUG_SHA=$(git rev-parse HEAD)

# --- noise after the bug ------------------------------------------------------
edit apps/mqtt-sample/README.md \
  "Set \`LOG_LEVEL=debug\` to see the structured JSON service logs during tests." \
  "Set \`LOG_LEVEL=debug\` to see the structured JSON service logs during tests or triggers."
commit "docs: mention LOG_LEVEL for scripts"

edit apps/mqtt-sample/test/setup.ts \
  "// Keep test output readable; set LOG_LEVEL=debug to see service logs." \
  "// Keep test output readable; set LOG_LEVEL=debug (or info) to see service logs."
commit "test: comment on LOG_LEVEL values"

edit apps/mqtt-sample/src/main.ts \
  " * Standalone entry point: starts the in-process broker, connects the hub and" \
  " * Standalone entry point for local runs: starts the in-process broker, connects the hub and"
commit "main: clarify entry-point comment"

git tag bad

echo "history ready at $OUT (good=$(git rev-parse --short good) bad=$(git rev-parse --short bad), $(git rev-list --count good..bad) commits after good)" >&2
echo "$BUG_SHA"
