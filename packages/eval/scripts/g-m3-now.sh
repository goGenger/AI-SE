#!/usr/bin/env bash
# G-M3 "run now" batch (2026-10-14, user override: no cooldown, tokens plentiful, run straight
# through): E1 x3 FIRST (acceptance core), then L3 regression. Same result paths; resume-capable.
# Guard accounts against the CURRENT weekly window (2026-10-11 23:00 UTC). ASCII-only.
# Usage: caffeinate -s -d -i bash packages/eval/scripts/g-m3-now.sh

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"

# Defaults centralized HERE (overridable via inherited env at relaunch):
export G_M3_WEEK_START="${G_M3_WEEK_START:-2026-10-11 23:00:00+00}"   # count the CURRENT window
export G_M3_COOLDOWN_SECS="${G_M3_COOLDOWN_SECS:-0}"                  # no cooldown between E1 runs
export G_M3_L3_COOLDOWN_SECS="${G_M3_L3_COOLDOWN_SECS:-0}"            # no cooldown between L3 runs
export G_M3_GUARD_LIMIT="${G_M3_GUARD_LIMIT:-30000000}"               # 30M stop-line (covers the full batch)

echo "G_M3_NOW_START $(date '+%F %T %Z')"
echo "G_M3_NOW_CONFIG week_start=$G_M3_WEEK_START e1_cooldown=$G_M3_COOLDOWN_SECS l3_cooldown=$G_M3_L3_COOLDOWN_SECS guard=$G_M3_GUARD_LIMIT"

bash "$ROOT/packages/eval/scripts/g-m3-e1-x3.sh"; echo "G_M3_NOW_E1X3_EXIT=$?"
bash "$ROOT/packages/eval/scripts/g-m3-l3.sh"; echo "G_M3_NOW_L3_EXIT=$?"

echo "G_M3_NOW_DONE $(date '+%F %T %Z')"
