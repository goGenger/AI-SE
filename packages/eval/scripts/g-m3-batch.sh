#!/usr/bin/env bash
# G-phase M3 exit batch (docs/130 sec.3): L3 regression (S/M/L x3) then E1 x3 acceptance,
# chained under one caffeinate session. Each stage is resume-capable and guarded
# (health + weekly budget + per-run checkpoints). ASCII-only.
set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"

echo "G_M3_BATCH_START $(date '+%F %T %Z')"
bash "$ROOT/packages/eval/scripts/g-m3-l3.sh"; echo "G_M3_L3_EXIT=$?"
bash "$ROOT/packages/eval/scripts/g-m3-e1-x3.sh"; echo "G_M3_E1X3_EXIT=$?"
echo "G_M3_BATCH_DONE $(date '+%F %T %Z')"
