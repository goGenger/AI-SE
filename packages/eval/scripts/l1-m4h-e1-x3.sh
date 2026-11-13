#!/usr/bin/env bash
# L1-M4h acceptance batch: the eighth attempt at the E1 full-chain x3 batch for the L1-8
# acceptance item (docs/154 sec.3 M4), now carrying the PL-M16 (N-9) fix on top of PL-M7..PL-M15.
#
# Batch history (each attempt is a separate results dir so runs are never mixed across platform
# versions - see docs/164 sec.7 item 4, docs/168 sec.7 item 7, docs/170 sec.7 item 8):
#   results/l1-m4   PL-M4   run 1 only (aborted: slice-outside red test killed the slice's dev task)
#   results/l1-m4b  L1-M4b  run 1 only (aborted: N-2 - the scaffold task could not write the
#                   repository root, so the workflow died on its FIRST task)
#   results/l1-m4c  L1-M4c  runs 1-2 (aborted: run 1 died in planning, run 2 reached the FINAL slice
#                   S4-deploy-ui for the first time - 47 tasks SUCCESS - then died on N-4)
#   results/l1-m4d  L1-M4d  runs 1-2 (aborted: both runs died on N-6, the gateway message-shape 400s)
#   results/l1-m4e  L1-M4e  run 1 only (aborted after 9 minutes: the outer AgentGraph hitting
#                   LangGraph's default recursionLimit of 25, on the FIRST task S1-01)
#   results/l1-m4f  L1-M4f  runs 1-2 (aborted: both runs died on N-8 - an absurd agent_runs
#                   token_usage value poisoned the weekly quota guard - and both stopped on T-01)
#   results/l1-m4g  L1-M4g  run 1 only (aborted: PL-M15 was CONFIRMED here - three guard-path runs,
#                   zero bad values - but the chain still died on the FIRST task. That run exposed
#                   N-9: the outer loop kept re-requesting submit_result 44 times in 1.2 s with no
#                   model call in any of them, until the 50-iteration guard fired)
#   results/l1-m4h  this batch (PL-M16 stops the outer loop from re-running a tool call the inner
#                   agent already executed, so a task that submits now ENDS in that round)
#
# QUOTA NOTE: the weekly reading at launch is 127,832,975 / 200,000,000 under the SANE guard
# (window opened 2026-10-11 23:00 UTC, refreshes 2026-10-18 23:00 UTC). The raw sum is meaningless
# (6.39e18) because N-8's historical bad rows are still in the table - they are ignored by the
# guard, never edited (AGENTS.md sec.6 red line). Measured per-workflow cost in the autonomy-L1 era
# runs 5M-16M, so three runs land at 15M-48M against 72M of headroom. The guard re-checks before
# every run.
#
# Contract is otherwise identical to l1-m4g-e1-x3.sh so the staging-segment numbers stay comparable
# with the G baseline and the seven earlier attempts.
#
# Watch items for this batch:
#   1. THE HEADLINE (PL-M16 / N-9): the spin must be ABSENT. Per agent run, compare the number of
#      outer rounds against the number of rounds that requested submit_result:
#        SELECT e.agent_run_id,
#               count(*) FILTER (WHERE e.event_type='agent_action') AS rounds,
#               count(*) FILTER (WHERE e.event_type='agent_action'
#                                AND e.payload->>'tools' LIKE '%submit_result%') AS sub_rounds
#        FROM workflow_events e WHERE e.event_type='agent_action'
#        GROUP BY e.agent_run_id ORDER BY min(e.created_at) DESC LIMIT 20;
#      A run with rounds >= 20 AND rounds = sub_rounds is spinning. Before the fix EVERY run in
#      these batches looked like that (41-50 rounds). After it, a task that submits should show a
#      handful of rounds. Also: the chain must get PAST the FIRST task - no batch has managed that
#      since l1-m4c run 2.
#   2. N-8 must stay ABSENT (PL-M15, already confirmed on l1-m4g run 1):
#        SELECT count(*) FROM agent_runs WHERE (token_usage->>'input_tokens')::bigint > 10000000;
#      History had 11 such rows, all on the maxIterations-guard path; the count must not grow, and
#      the guard's weekly reading must stay in the 1e8 range.
#   3. N-7 must stay ABSENT:
#        "Recursion limit of 25 reached without hitting a stop condition"
#   4. The two N-6 gateway 400s must stay ABSENT:
#        "The `reasoning_content` in the thinking mode must be passed back to the API"
#        "tool message content must be a string on the gRPC path"
#   5. Reaching the delivery slice ui-deploy-docs would be the FIRST real test of PL-M11 / PL-M12.
#      S4-15 (BUILD) and S4-16..18 (DEPLOY) are what has to reach the staging segment
#      (CI AND staging DEPLOY AND staging VERIFY) for L1-8 (docs/154 sec.3).
#   6. PLAN_TEST_BEFORE_SCRIPT_PROVIDER / TASK_CHECK_UNAVAILABLE frequency (docs/167 KI 1).
#   7. scopeViolations should stay 0 (PL-M12).
#   8. Read-side denial is still expected (docs/171 KI 1): readPaths were deliberately not widened,
#      so a "Path is not readable: Dockerfile" TOOL_ERROR is not a regression.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4h-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4h-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4h"
mkdir -p "$OUT_DIR"

WEEK_START="${L1_M4H_WEEK_START:-2026-10-11 23:00:00+00}"   # weekly window (docs/127)
GUARD_LIMIT="${L1_M4H_GUARD_LIMIT:-200000000}"             # 200M stop-line (user ruling 2026-10-14)
COOLDOWN_SECS="${L1_M4H_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4H_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4H_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4H_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4H_E1_X3_ALL_COMPLETE"
