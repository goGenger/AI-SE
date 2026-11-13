#!/usr/bin/env bash
# L1-M4b acceptance batch: the E1 full-chain x3 rerun of the aborted L1-M4 batch (docs/155 M4 /
# acceptance item L1-8), now carrying the planner/verification fixes landed after PL-M4 run 1.
#
# Why a separate batch instead of resuming results/l1-m4: PL-M4 run 1 was produced by the platform
# BEFORE PL-M7 / PL-M8 / PL-M9 (user ruling 2026-10-16: runs 2/3 are not run, because mixing the
# pre-fix and post-fix platform versions would make the three runs incomparable). results/l1-m4 is
# therefore frozen history; this batch writes to results/l1-m4b.
#
# Contract is otherwise identical to l1-m4-e1-x3.sh (per-run checkpoint, weekly guard, cooldown,
# resume-capable, run 1 uses --replan) so the staging-segment numbers stay comparable with the
# G baseline and with PL-M4 run 1.
#
# Watch items for this batch (docs/167 Known Issues 1):
#   PLAN_TEST_BEFORE_SCRIPT_PROVIDER frequency  (9b guard fired => planner declared providesScripts)
#   TASK_CHECK_UNAVAILABLE frequency            (9a observation event)
#   If the first is 0 while the second is non-zero, the planner is not declaring providesScripts
#   and 9c has turned the silent hole into a hard stop - revisit the prompt or the 9c judgement.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4b-e1-x3.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4b"
mkdir -p "$OUT_DIR"

WEEK_START="${L1_M4B_WEEK_START:-2026-10-11 23:00:00+00}"   # OpenCode Go weekly window (docs/127)
GUARD_LIMIT="${L1_M4B_GUARD_LIMIT:-200000000}"             # 200M stop-line (user ruling 2026-10-14)
COOLDOWN_SECS="${L1_M4B_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4B_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4B_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4B_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4B_E1_X3_ALL_COMPLETE"
