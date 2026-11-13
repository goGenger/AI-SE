#!/usr/bin/env bash
# L1-M4i acceptance batch: the ninth attempt at the E1 full-chain x3 batch for the L1-8
# acceptance item (docs/154 sec.3 M4), now carrying the PL-M17 (N-6 recurrence) fix on top
# of PL-M7..PL-M16.
#
# Batch history (each attempt is a separate results dir so runs are never mixed across
# platform versions - see docs/164 sec.7 item 4, docs/168 sec.7 item 7, docs/170 sec.7
# item 8, docs/179 sec.7 item 5):
#   results/l1-m4   PL-M4   run 1 only (aborted: slice-outside red test killed the slice's dev task)
#   results/l1-m4b  L1-M4b  run 1 only (aborted: N-2 - the scaffold task could not write the
#                   repository root, so the workflow died on its FIRST task)
#   results/l1-m4c  L1-M4c  runs 1-2 (aborted: run 1 died in planning, run 2 reached the FINAL
#                   slice S4-deploy-ui for the first time - 47 tasks SUCCESS - then died on N-4)
#   results/l1-m4d  L1-M4d  runs 1-2 (aborted: both runs died on N-6, the gateway message-shape 400s)
#   results/l1-m4e  L1-M4e  run 1 only (aborted after 9 minutes: the outer AgentGraph hitting
#                   LangGraph's default recursionLimit of 25, on the FIRST task S1-01)
#   results/l1-m4f  L1-M4f  runs 1-2 (aborted: both runs died on N-8 - an absurd agent_runs
#                   token_usage value poisoned the weekly quota guard - and both stopped on T-01)
#   results/l1-m4g  L1-M4g  run 1 only (aborted: PL-M15 was CONFIRMED here, but the chain still
#                   died on the FIRST task, exposing N-9)
#   results/l1-m4h  L1-M4h  all three runs (E1x3 COMPLETED, 03:43:05): PL-M16 was CONFIRMED -
#                   criterion 16h met, ZERO spin across 64 agent runs - and the chain finally
#                   went deeper (run 3 cleared slice-2 10/10 and reached slice-3 for the first
#                   time). But staging segment 0/3, and N-6 RECURRED 5 times (0/2/3 per run),
#                   plus a new wall: the core-implementation BACKEND task (see below)
#   results/l1-m4i  this batch (PL-M17 stops the gateway's reasoning_content 400 by sending an
#                   empty reasoning_content for a tool-call assistant message that never had one)
#
# QUOTA NOTE: the weekly reading at launch is 156,801,600 / 200,000,000 under the SANE guard
# (window opened 2026-10-11 23:00 UTC, refreshes 2026-10-18 23:00 UTC = 2026-10-19 07:00 CST).
# L1-M4h's three runs cost 28,968,625 input tokens, so the remaining headroom covers this batch
# with a modest margin. The guard re-checks before EVERY run and is fail-closed, so the worst
# case is a clean stop after a run, never a run cut mid-flight.
#
# Contract is otherwise identical to l1-m4h-e1-x3.sh so the staging-segment numbers stay
# comparable with the H baseline and the eight earlier attempts.
#
# Watch items for this batch:
#   1. THE HEADLINE (PL-M17): N-6 must stay ABSENT. History has it at 10-07 / 10-09 / 10-14 /
#      10-17 (L1-M4d and L1-M4h). The fix sends an empty reasoning_content where the gateway
#      never gave one (docs/182). If it recurs, PL-M17's fix is incomplete:
#        SELECT count(*) FROM agent_runs WHERE created_at >= '<batch start>'
#          AND error::text LIKE '%reasoning_content%';
#   2. THE NEXT WALL (most likely to stop the chain, and NOT yet fixed): the
#      core-implementation BACKEND task. It reproduced in all three L1-M4h runs - the task's
#      `test` check hangs (`exitCode: null`) and the agent then edits a protected test file,
#      which anti-tamper correctly blocks (DEV_TASK_TYPES has BACKEND but not TEST). Watch:
#        SELECT created_at::time(0), payload->>'taskType', payload->>'antiTamper',
#               left(payload->>'reason', 60)
#        FROM workflow_events WHERE event_type='TASK_VERIFICATION'
#          AND payload->>'verdict'='failed' ORDER BY created_at;
#      A run that gets PAST slice-3 would be the deepest yet.
#   3. N-9 must stay ABSENT (PL-M16, confirmed on L1-M4h): the outer loop must not re-request a
#      tool. Zero `agent_action` events with `action: "tool_call_requested"`:
#        SELECT payload->>'action', count(*) FROM workflow_events
#        WHERE event_type='agent_action' GROUP BY 1;
#      (L1-M4h: only 2 rows, both `empty_reply_retry`. Pre-fix: 100% `tool_call_requested`.)
#   4. N-8 must stay ABSENT (PL-M15, confirmed on L1-M4g and L1-M4h):
#        SELECT count(*) FROM agent_runs WHERE (token_usage->>'input_tokens')::bigint > 10000000;
#      History has 11 such rows; the count must not grow.
#   5. N-7 must stay ABSENT: "Recursion limit of 25 reached without hitting a stop condition".
#   6. The other N-6 400 must stay ABSENT: "tool message content must be a string on the gRPC path".
#   7. Reaching the delivery slice ui-deploy-docs would be the FIRST real test of PL-M11 / PL-M12.
#      S4-15 (BUILD) and S4-16..18 (DEPLOY) are what has to reach the staging segment
#      (CI AND staging DEPLOY AND staging VERIFY) for L1-8 (docs/154 sec.3).
#   8. PLAN_TEST_BEFORE_SCRIPT_PROVIDER / TASK_CHECK_UNAVAILABLE frequency (docs/167 KI 1).
#   9. scopeViolations should stay 0 (PL-M12).
#  10. EMPTY_FINAL_ANSWER frequency (5 rows in L1-M4h, mechanism unknown, not yet filed).
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4i-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4i-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4i"
mkdir -p "$OUT_DIR"

WEEK_START="${L1_M4I_WEEK_START:-2026-10-11 23:00:00+00}"   # weekly window (docs/127)
GUARD_LIMIT="${L1_M4I_GUARD_LIMIT:-200000000}"             # 200M stop-line (user ruling 2026-10-14)
COOLDOWN_SECS="${L1_M4I_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4I_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4I_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4I_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4I_E1_X3_ALL_COMPLETE"
