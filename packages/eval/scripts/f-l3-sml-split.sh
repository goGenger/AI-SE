#!/usr/bin/env bash
# F-phase L3 regression batch (docs/128 sec.7): S/M/L x3 on the F-phase controlled instance.
# Mirrors the E-2b batch contract (--replan on run 1 per fixture; weekly budget guard;
# 120s cooldown between runs). Split per-run invocations so completed runs are checkpointed.
# RESUME-CAPABLE: runs whose result JSON already exists are skipped (added for the
# 2026-10-12 resume batch; week window bumped to 2026-10-11 23:00 UTC).
# Usage: caffeinate -s -d -i bash packages/eval/scripts/f-l3-sml-split.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/f/l3"
mkdir -p "$OUT_DIR"

WEEK_START="2026-10-11 23:00:00+00"   # weekly window start (UTC); previous window 10-04 was stopped at 18.50M
GUARD_LIMIT=20000000                   # 20M input tokens stop-line
COOLDOWN_SECS=120                      # short gap between runs
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
log "F_L3_SML_ALL_COMPLETE"
