#!/usr/bin/env bash
# E1 C-6 batch: split-mode x3 (fresh plans under C-phase code, VERIFICATION_GATE=enforce)
# + weekly budget guard + cooldown. Mirrors e1-baseline-split.sh methodology.
# Usage: caffeinate -s -d -i bash packages/eval/scripts/e1-c6-split.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/e1-c6"
mkdir -p "$OUT_DIR"

WEEK_START="2026-10-04 23:00:00+00"   # same weekly window as the B baseline
GUARD_LIMIT=20000000                   # 20M input tokens stop-line
COOLDOWN_SECS=1800                     # 30 min between runs (rolling 5h window)
BASE_URL="http://127.0.0.1:47557"

log() { echo "[$(date '+%F %T %Z')] $*"; }

. "$ROOT/packages/eval/scripts/lib/usage-guard.sh"

for n in 1 2 3; do
  health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE_URL/health" || true)
  if [ "$health" != "200" ]; then log "FATAL: platform unhealthy (health=$health), abort"; exit 4; fi

  used=$(week_tokens)
  case "$used" in
    ''|*[!0-9]*) log "BUDGET-GUARD: cannot read weekly usage ($used), abort"; exit 3 ;;
  esac
  log "before run $n: weekly used=$used limit=$GUARD_LIMIT"
  if [ "$used" -ge "$GUARD_LIMIT" ]; then log "BUDGET-GUARD: limit reached, stop"; exit 2; fi

  log "run $n start"
  EVAL_BASE_URL="$BASE_URL" corepack pnpm --filter @ai-se/eval start --fixtures E1 --runs 1 --out "$OUT_DIR/run-$n.json" 2>&1
  log "run $n done exit=$?"

  if [ "$n" -lt 3 ]; then log "cooldown ${COOLDOWN_SECS}s"; sleep "$COOLDOWN_SECS"; fi
done
log "E1_C6_ALL_COMPLETE"
