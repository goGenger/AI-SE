#!/usr/bin/env bash
# E-2 batch (docs/125): P0 set re-test, S/M/L x3 in split per-run invocations,
# weekly budget guard + brief cooldown between runs.
# Usage: caffeinate -s -d -i bash packages/eval/scripts/e2-sml-split.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/e2"
mkdir -p "$OUT_DIR"

WEEK_START="2026-10-04 23:00:00+00"   # weekly window start (UTC); confirm via console
GUARD_LIMIT=20000000                   # 20M input tokens stop-line
COOLDOWN_SECS=120                      # short gap between runs
BASE_URL="http://127.0.0.1:47557"

log() { echo "[$(date '+%F %T %Z')] $*"; }

. "$ROOT/packages/eval/scripts/lib/usage-guard.sh"

run_one() {
  fixture="$1"; n="$2"
  health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE_URL/health" || true)
  if [ "$health" != "200" ]; then log "FATAL: platform unhealthy (health=$health), abort"; exit 4; fi

  used=$(week_tokens)
  case "$used" in
    ''|*[!0-9]*) log "BUDGET-GUARD: cannot read weekly usage ($used), abort"; exit 3 ;;
  esac
  log "before $fixture run $n: weekly used=$used limit=$GUARD_LIMIT"
  if [ "$used" -ge "$GUARD_LIMIT" ]; then log "BUDGET-GUARD: limit reached, stop"; exit 2; fi

  log "$fixture run $n start"
  EVAL_BASE_URL="$BASE_URL" corepack pnpm --filter @ai-se/eval start --fixtures "$fixture" --runs 1 --out "$OUT_DIR/${fixture}-run${n}.json" 2>&1
  log "$fixture run $n done exit=$?"
  sleep "$COOLDOWN_SECS"
}

for fixture in S1 S2 S3 M1 M2 M3 L1 L2; do
  for n in 1 2 3; do
    run_one "$fixture" "$n"
  done
done
log "E2_SML_ALL_COMPLETE"
