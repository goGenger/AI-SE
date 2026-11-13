#!/usr/bin/env bash
# G-M3 run-2 replacement round (2026-10-14, user ruling): run-2 invalidated as an environment
# anomaly round; re-run it under IDENTICAL conditions after the run-now batch finishes.
# Archives existing run-2 artifacts, then invokes the standard e1-x3 runner (it skips runs 1/3
# whose results exist and re-runs only the missing run-2). ASCII-only.
# Usage: bash packages/eval/scripts/g-m3-e1-run2b.sh
set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/g/l4"

STAMP="$(date '+%Y%m%d-%H%M%S')"
if [ -f "$OUT_DIR/run-2.json" ]; then
  mv "$OUT_DIR/run-2.json" "$OUT_DIR/run-2.invalid-env-$STAMP.json"
  if [ -f "$OUT_DIR/run-2-summary.md" ]; then
    mv "$OUT_DIR/run-2-summary.md" "$OUT_DIR/run-2.invalid-env-$STAMP-summary.md"
  fi
  echo "archived old run-2 artifacts (stamp $STAMP)"
fi

echo "G_M3_RUN2B_START $(date '+%F %T %Z')"
G_M3_WEEK_START="2026-10-11 23:00:00+00" G_M3_COOLDOWN_SECS=0 G_M3_GUARD_LIMIT="${G_M3_GUARD_LIMIT:-200000000}" \
  bash "$ROOT/packages/eval/scripts/g-m3-e1-x3.sh"
echo "G_M3_RUN2B_EXIT=$?"
echo "G_M3_RUN2B_DONE $(date '+%F %T %Z')"
