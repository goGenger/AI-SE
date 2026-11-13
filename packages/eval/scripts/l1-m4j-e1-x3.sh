#!/usr/bin/env bash
# L1-M4j acceptance batch: the tenth attempt at the E1 full-chain x3 batch for the L1-8
# acceptance item (docs/154 sec.3 M4), now carrying the PL-M18 fixes (N-10 TEST red-light
# scope fallback, N-11 REVIEW negative-verdict path) on top of PL-M7..PL-M17.
#
# Batch history (each attempt is a separate results dir so runs are never mixed across
# platform versions - see docs/164 sec.7 item 4, docs/168 sec.7 item 7, docs/170 sec.7
# item 8, docs/179 sec.7 item 5):
#   results/l1-m4    PL-M4   run 1 only (aborted: slice-outside red test killed the slice's dev task)
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
#   results/l1-m4h  L1-M4h  all three runs (E1x3 COMPLETED): PL-M16 CONFIRMED - criterion 16h
#                   met, ZERO spin across 64 agent runs - and run 3 cleared slice-2 and reached
#                   slice-3 for the first time. But staging segment 0/3, N-6 recurred 5 times,
#                   and a new wall appeared (the core-implementation BACKEND task)
#   results/l1-m4i  L1-M4i  runs 1-2 (aborted by the budget guard before run 3): PL-M17 was
#                   CONFIRMED - N-6 stayed ABSENT across 76 agent runs - and run 2 went deeper
#                   than any run before (slices 1-3 all green, first entry into slice-4). But
#                   staging segment 0/2, and two NEW platform-side defeat points appeared:
#                   N-10 (TEST red-light scope fallback) and N-11 (REVIEW negative verdict)
#   results/l1-m4j  this batch (PL-M18 fixes BOTH: the red-light scope narrows to the task's own
#                   slice when it has no acKeys anchor, and a failed REVIEW's fix task lands on a
#                   WORK type instead of being replanned into another REVIEW)
#
# POLICY NOTE: PL-M18 changed the autonomy-L1 failure response from RETRY to REPLAN
# (failureStrategy "REPLAN" + allowReplan true), in BOTH packages/eval and packages/shared.
# **This batch is therefore NOT strictly comparable with the 18 earlier E1 runs** (docs/184).
# The effective policy is written into every run JSON, so the batch self-documents the setting.
#
# QUOTA NOTE: the guard below computes the provider week from "now" (anchor 2026-10-11 23:00 UTC,
# 7-day cadence) instead of a hardcoded date. A hardcoded date would read an EMPTY window once the
# boundary passes while a stale one would read a closed window forever; computing it can do
# neither, and it is strictly stricter before the boundary (it keeps reading the current week).
#
# Contract is otherwise identical to l1-m4i-e1-x3.sh so the staging-segment numbers stay
# comparable in shape with the nine earlier attempts.
#
# Watch items for this batch:
#   1. THE PL-M18 HEADLINE (N-10): the red-light check must no longer fail a TEST task for AC
#      keys that belong to other slices. Look for `VACUOUS_TEST` with an `uncovered:` list in
#      the reason; the old failure mode had NO uncovered list because the reason named only the
#      check. History: L1-M4i run 1 died on T10 this way.
#        SELECT created_at::time(0), payload->>'taskType', payload->>'reason'
#        FROM workflow_events WHERE event_type='TASK_VERIFICATION'
#          AND payload->>'verdict'='failed' AND created_at >= '<batch start>';
#   2. THE PL-M18 HEADLINE (N-11): a failed REVIEW whose agent reported a negative verdict must
#      now produce REPLAN tasks (`<taskKey>-DEBUG-1` and `<taskKey>-REPLAN-1`), and the REPLAN
#      task must be a WORK type (BACKEND/FRONTEND/DATABASE), NOT REVIEW. Watch:
#        SELECT task_key, type, status, origin FROM tasks
#        WHERE created_at >= '<batch start>' AND origin='DYNAMIC' ORDER BY created_at;
#      Also watch the COST: every failed task now spawns two dynamic tasks (KNOWN cost risk,
#      docs/184 Known Issues 2).
#   3. N-6 must stay ABSENT (PL-M17): SELECT count(*) FROM agent_runs
#      WHERE created_at >= '<batch start>' AND error::text LIKE '%reasoning_content%';
#   4. N-9 must stay ABSENT (PL-M16): zero `agent_action` events with action `tool_call_requested`:
#        SELECT payload->>'action', count(*) FROM workflow_events
#        WHERE event_type='agent_action' GROUP BY 1;
#   5. N-8 must stay ABSENT (PL-M15): the count of `input_tokens > 10M` must not grow (11).
#   6. N-7 must stay ABSENT: "Recursion limit of 25 reached without hitting a stop condition".
#   7. The other N-6 400 must stay ABSENT: "tool message content must be a string on the gRPC path".
#   8. Reaching the delivery slice ui-deploy-docs would be the FIRST real test of PL-M11 / PL-M12.
#   9. scopeViolations should stay 0 (PL-M12).
#  10. EMPTY_FINAL_ANSWER frequency (5 rows in L1-M4h, 1 in L1-M4i, mechanism unknown).
#  11. The BACKEND `checks failed: test` wall (L1-M4h's suspected next wall): L1-M4i cleared it
#      twice by retry, so it should NOT be treated as the primary suspect any more.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4j-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4j-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4j"
mkdir -p "$OUT_DIR"

# Provider week boundary: anchor 2026-10-11 23:00 UTC, 7-day cadence, computed from "now".
# Anchor epoch 1791759600. See the QUOTA NOTE above for why this is computed, not hardcoded.
week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${L1_M4J_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${L1_M4J_GUARD_LIMIT:-200000000}"             # 200M stop-line (user ruling 2026-10-14)
COOLDOWN_SECS="${L1_M4J_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4J_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4J_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4J_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4J_E1_X3_ALL_COMPLETE"
