#!/usr/bin/env bash
# G-phase M3 acceptance batch (docs/130 sec.3 G-M3): E1 full-chain x3 on the G-phase controlled
# instance (two-level planning + VERIFICATION_GATE=enforce + tool submit + G3 timeout table).
# Mirrors the F-phase L4 batch contract (weekly guard, 30-min cooldown) plus the per-run
# checkpoint pattern. Run 1 uses --replan (fresh plan version with the G2 involvesData field;
# same batch contract as E-2b/L3/F-L4). RESUME-CAPABLE: runs whose result JSON already
# exists are skipped.
# Usage: caffeinate -s -d -i bash packages/eval/scripts/g-m3-e1-x3.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/g/l4"
mkdir -p "$OUT_DIR"

WEEK_START="${G_M3_WEEK_START:-2026-10-18 23:00:00+00}"   # G-M3 weekly window (override: G_M3_WEEK_START for a run-now batch)
GUARD_LIMIT="${G_M3_GUARD_LIMIT:-20000000}"   # 20M default stop-line (override: G_M3_GUARD_LIMIT)
COOLDOWN_SECS="${G_M3_COOLDOWN_SECS:-1800}"   # 30 min between runs (E-1/F-L4 batch precedent)
BASE_URL="http://127.0.0.1:47557"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${G_M3_DEADLINE_EPOCH:-0}"    # optional: no NEW run starts at/after this epoch (0 = disabled)

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
  if [ "$rc" = "42" ]; then log "G_M3_DEADLINE_STOP"; exit 0; fi
done
log "G_M3_E1_ALL_COMPLETE"
