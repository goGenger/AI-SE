#!/usr/bin/env bash
# L1-M4 acceptance batch (docs/154 sec.3 M4 / acceptance item L1-8): E1 full-chain x3 under the
# autonomy L1 policy, measuring the STAGING SEGMENT (CI + staging DEPLOY + staging VERIFY), not
# deliveredSuccess (deprecated by user ruling 2026-10-15, see docs/131 appended block).
#
# Mirrors the G-M3 batch contract (per-run checkpoint, weekly guard, cooldown, resume-capable)
# with two changes:
#   1. every run passes --autonomy-l1 (the eval CLI overlays L1_WORKFLOW_POLICY onto the frozen
#      P0 policy; the effective policy is written into each result JSON);
#   2. the target instance is the dedicated :47558 launcher (l1-m4-server-launch.sh), because the
#      leftover :47557 instance predates the L1 code.
#
# Run 1 uses --replan (fresh plan version) - same batch contract as E-2b/L3/F-L4/G-M3.
# RESUME-CAPABLE: runs whose result JSON already exists are skipped.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4-e1-x3.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4"
mkdir -p "$OUT_DIR"

WEEK_START="${L1_M4_WEEK_START:-2026-10-11 23:00:00+00}"   # OpenCode Go weekly window (docs/127)
GUARD_LIMIT="${L1_M4_GUARD_LIMIT:-200000000}"             # 200M stop-line (user ruling 2026-10-14)
COOLDOWN_SECS="${L1_M4_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  log "run $n start (autonomy-l1 extra=$EXTRA)"
  ( cd "$ROOT/packages/eval" && EVAL_BASE_URL="$BASE_URL" "$TSX" src/cli.ts \
      --fixtures E1 --runs 1 --autonomy-l1 --out "$OUT_DIR/run-$n.json" $EXTRA ) 2>&1
  log "run $n done exit=$?"
  sleep "$COOLDOWN_SECS"
}

for n in 1 2 3; do
  run_one "$n"
  rc=$?
  if [ "$rc" = "42" ]; then log "L1_M4_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4_E1_X3_ALL_COMPLETE"
