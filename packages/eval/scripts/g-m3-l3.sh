#!/usr/bin/env bash
# G-phase M3 L3 regression batch (docs/130 sec.3 G-M3): S/M/L x3 on the G-phase controlled
# instance (two-level planning + VERIFICATION_GATE=enforce + tool submit + G3 timeout table).
# Mirrors the F-phase L3 batch contract (--replan on run 1 per fixture; weekly budget guard;
# 120s cooldown between runs). Split per-run invocations so completed runs are checkpointed.
# RESUME-CAPABLE: runs whose result JSON already exists are skipped.
# Usage: caffeinate -s -d -i bash packages/eval/scripts/g-m3-l3.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/g/l3"
mkdir -p "$OUT_DIR"

WEEK_START="${G_M3_WEEK_START:-2026-10-18 23:00:00+00}"   # G-M3 weekly window (override: G_M3_WEEK_START for a run-now batch)
GUARD_LIMIT="${G_M3_GUARD_LIMIT:-20000000}"   # 20M default stop-line (override: G_M3_GUARD_LIMIT)
COOLDOWN_SECS="${G_M3_L3_COOLDOWN_SECS:-120}"  # short gap between runs (override: G_M3_L3_COOLDOWN_SECS)
BASE_URL="http://127.0.0.1:47557"
TSX="$ROOT/node_modules/.bin/tsx"

log() { echo "[$(date '+%F %T %Z')] $*"; }

. "$ROOT/packages/eval/scripts/lib/usage-guard.sh"

run_one() {
  fixture="$1"; n="$2"
  if [ -f "$OUT_DIR/${fixture}-run${n}.json" ]; then log "$fixture run $n result exists, skip"; return 0; fi
  health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE_URL/health" || true)
  if [ "$health" != "200" ]; then log "FATAL: platform unhealthy (health=$health), abort"; exit 4; fi

  used=$(week_tokens)
  case "$used" in
    ''|*[!0-9]*) log "BUDGET-GUARD: cannot read weekly usage ($used), abort"; exit 3 ;;
  esac
  log "before $fixture run $n: weekly used=$used limit=$GUARD_LIMIT"
  if [ "$used" -ge "$GUARD_LIMIT" ]; then log "BUDGET-GUARD: limit reached, stop"; exit 2; fi

  EXTRA=""
  if [ "$n" = "1" ]; then EXTRA="--replan"; fi
  log "$fixture run $n start (extra=$EXTRA)"
  ( cd "$ROOT/packages/eval" && EVAL_BASE_URL="$BASE_URL" "$TSX" src/cli.ts \
      --fixtures "$fixture" --runs 1 --out "$OUT_DIR/${fixture}-run${n}.json" $EXTRA ) 2>&1
  log "$fixture run $n done exit=$?"
  sleep "$COOLDOWN_SECS"
}

for fixture in S1 S2 S3 M1 M2 M3 L1 L2; do
  for n in 1 2 3; do
    run_one "$fixture" "$n"
  done
done
log "G_M3_L3_ALL_COMPLETE"
