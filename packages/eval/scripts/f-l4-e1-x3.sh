#!/usr/bin/env bash
# F-phase L4 acceptance batch (docs/128 sec.7/8): E1 full-chain x3 on the F-phase controlled
# instance (two-level planning + VERIFICATION_GATE=enforce + tool submit). Mirrors the E-1 batch
# contract (weekly guard, 30-min cooldown) plus the L3 checkpoint-skip pattern. Run 1 uses
# --replan (fresh plan version; same batch contract as E-2b/L3).
# RESUME-CAPABLE: runs whose result JSON already exists are skipped.
# Usage: caffeinate -s -d -i bash packages/eval/scripts/f-l4-e1-x3.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/f/l4"
mkdir -p "$OUT_DIR"

WEEK_START="2026-10-11 23:00:00+00"   # current weekly window (L3 batch consumed 8.63M of 20M)
GUARD_LIMIT=20000000                   # 20M input tokens stop-line
COOLDOWN_SECS="${F_L4_COOLDOWN_SECS:-1800}"   # 30 min between runs (E-1 batch precedent)
BASE_URL="http://127.0.0.1:47557"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${F_L4_DEADLINE_EPOCH:-0}"    # optional: no NEW run starts at/after this epoch (0 = disabled)

log() { echo "[$(date '+%F %T %Z')] $*"; }

. "$ROOT/packages/eval/scripts/lib/usage-guard.sh"

run_one() {
  n="$1"
  if [ "$DEADLINE_EPOCH" -gt 0 ] && [ "$(date +%s)" -ge "$DEADLINE_EPOCH" ]; then
    log "DEADLINE reached - no new run starts (completed runs are safe)"
    return 42
  fi
  if [ -f "$OUT_DIR/run-$n.json" ]; then log "run $n result exists, skip"; return 0; fi
  health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE_URL/health" || true)
  if [ "$health" != "200" ]; then log "FATAL: platform unhealthy (health=$health), abort"; exit 4; fi

  used=$(week_tokens)
  case "$used" in
    ''|*[!0-9]*) log "BUDGET-GUARD: cannot read weekly usage ($used), abort"; exit 3 ;;
  esac
  log "before run $n: weekly used=$used limit=$GUARD_LIMIT"
  if [ "$used" -ge "$GUARD_LIMIT" ]; then log "BUDGET-GUARD: limit reached, stop"; exit 2; fi

  EXTRA=""
  if [ "$n" = "1" ]; then EXTRA="--replan"; fi
  log "run $n start (extra=$EXTRA)"
  ( cd "$ROOT/packages/eval" && EVAL_BASE_URL="$BASE_URL" "$TSX" src/cli.ts \
      --fixtures E1 --runs 1 --out "$OUT_DIR/run-$n.json" $EXTRA ) 2>&1
  log "run $n done exit=$?"
  sleep "$COOLDOWN_SECS"
}

for n in 1 2 3; do
  run_one "$n"
  rc=$?
  if [ "$rc" = "42" ]; then log "F_L4_DEADLINE_STOP"; exit 0; fi
done
log "F_L4_E1_ALL_COMPLETE"
