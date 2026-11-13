#!/usr/bin/env bash
# L1-M4t: E1 x3 under autonomy L1. First batch after N-31 (PL-M32) and N-32 (PL-M33).
#
# WHAT CHANGED SINCE L1-M4s
#   N-31 / PL-M32 (docs/215): DeliveryOrchestrator.canHandle now dispatches on `input.delivery`
#     ALONE instead of the BUILD+CI / DEPLOY+DEPLOY / TEST+VERIFY type triples. In L1-M4s the
#     final slice planned VERIFY on a REVIEW task (TP-12) - twice out of two runs - so the
#     orchestrator refused it, a professional agent ran a code review instead ("Reviewed the
#     staging slice ... without modifying any file"), the task still reported SUCCESS, and the
#     staging-segment metric read `verify=SUCCESS` for a verification that never ran.
#     WorkflowEngine.isAutoApprovedStagingDeploy dropped the same type gate.
#   N-32 / PL-M33 (docs/216): harness now approves task-level approvals (production DEPLOY)
#     and counts each as a human intervention. Before this, a run that reached the final slice
#     sat in WAITING_APPROVAL for the full E1 runTimeoutMs (2 hours): M4s run 1 stalled 67 min
#     until it was approved by hand, run 2 burned the whole 2-hour timeout.
#   Eval diagnostics: on oracle failure the harness now logs the FULL oracle output. In M4s
#     only `oracle.output.slice(0, 120)` was logged, so the per-AC reasons for AC-20 / AC-27
#     were truncated away and could not be investigated.
#
# WHAT THIS BATCH PROVES
#   33a  The staging VERIFY task is executed by `delivery-orchestrator`, not by a professional
#        agent. Check: agent_runs.input.runtime for the task carrying delivery.action=VERIFY.
#   33b  staging-segment `verify` reflects a real verification (i.e. 33a holds).
#   34a  Production DEPLOY no longer strands the workflow in WAITING_APPROVAL.
#   34b  humanInterventions counts that approval (>= 1 on a run that reaches the final slice).
#   34c  No run burns the 2-hour timeout sitting on an approval.
#   diag AC-20 / AC-27: the full oracle output is now in this log. Both failed 2/2 in M4s
#        while the agents' OWN tests for them passed - see docs/213 follow-up.
#
# ACCOUNTING CHANGES (declared before the run - do not read as regressions)
#   - humanInterventions WILL rise: every production DEPLOY approval adds one.
#   - Run duration WILL be longer than a timed-out run and shorter than a 2-hour stall.
#   - chainCompleted and the staging segment are NOT affected by the approval change; their
#     decision surface is task status, not workflow terminal state.
#
# BUILD PRECONDITION (verified before launch)
#   packages/workflow-engine dist rebuilt AND the platform server restarted afterwards
#   (pid 93175, up since 09:12:32 - after both edits). A dist rebuild does NOT hot-reload the
#   running server. packages/eval runs from src via tsx, so its changes need no rebuild.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4t-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4t-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4t"
mkdir -p "$OUT_DIR"

week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${L1_M4T_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${L1_M4T_GUARD_LIMIT:-700000000}"
COOLDOWN_SECS="${L1_M4T_COOLDOWN_SECS:-1800}"
PORT="${L1_M4T_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4T_DEADLINE_EPOCH:-0}"

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
  if [ "$rc" = "42" ]; then log "L1_M4T_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4T_E1_X3_ALL_COMPLETE"
