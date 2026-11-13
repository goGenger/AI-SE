#!/usr/bin/env bash
# L1-M4s: E1 x3 under autonomy L1. First batch after N-30 (docs/213).
#
# WHAT CHANGED SINCE L1-M4r
#   N-30: `validateImplementationCoverage` (packages/agent-core/src/planning/
#   validateImplementationCoverage.ts:32) requires every Must AC to be referenced by a
#   BACKEND/FRONTEND/DATABASE task. That rule was NEVER stated to the planner - neither the
#   task-planning prompt nor the repair prompt said which types count. L1-M4r run 3 proved the
#   consequence: slices 1 and 2 both SUCCEEDED (first time in the L1-M4x series), then the FINAL
#   slice (slice-3-tasks) failed planning on 3 consecutive attempts, each reporting the same
#   5 gaps (AC-24/25/26/29/30 - all container/build criteria), escalated, retried from scratch,
#   failed again, and the run ended. Global ACs are assigned to the final slice only
#   (acceptanceCriteria.ts:184-192), so this wall is DETERMINISTIC: no run can ever reach the
#   delivery segment until it is fixed.
#   PL-M31 added the missing rule to the task-planning acHint (PlanningGraph.ts, the hint is
#   rebuilt on every attempt, so repair rounds see it too).
#
# WHAT THIS BATCH PROVES
#   32a  The final slice (slice-3-tasks) passes DAG validation on attempt 0 or after repair.
#   32b  A run reaches the delivery chain (CI BUILD / staging DEPLOY / staging VERIFY).
#   32c  staging segment delivery rate becomes measurable (> 0 or 0 with a named blocker).
#   Regression watch: slices 1 and 2 must still pass (M4r run 3 got both).
#
# BUILD PRECONDITION (verified before launch)
#   `packages/agent-core` dist rebuilt AND the platform server restarted afterwards.
#   A dist rebuild does NOT hot-reload the already-running server (measured: the M4r server had
#   been up 3h39m across a rebuild), so the restart is mandatory or this batch tests old code.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4s-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4s-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4s"
mkdir -p "$OUT_DIR"

week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${L1_M4S_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${L1_M4S_GUARD_LIMIT:-700000000}"
COOLDOWN_SECS="${L1_M4S_COOLDOWN_SECS:-1800}"
PORT="${L1_M4S_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4S_DEADLINE_EPOCH:-0}"

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
  log "window=$WEEK_START before run $n: weekly used=$used limit=$GUARD_LIMIT"
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
  if [ "$rc" = "42" ]; then log "L1_M4S_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4S_E1_X3_ALL_COMPLETE"
