#!/usr/bin/env bash
# L1-M4l acceptance batch: the twelfth attempt at the E1 full-chain x3 batch for the L1-8
# acceptance item (docs/154 sec.3 M4), now carrying the PL-M20 fix (N-13: the platform-built
# AC-scoped test command `node --test --test-name-pattern '...'` NEVER RETURNED when a test file
# had zero matching tests) on top of PL-M7..PL-M19.
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
#   results/l1-m4j  L1-M4j  all three runs (E1x3 COMPLETED): PL-M18 was CONFIRMED - N-11's REPLAN
#                   path was used heavily (18 dynamic tasks, where the whole database had ZERO
#                   before; 3 failures cleanly rescued; the work-type fallback fired every time)
#                   and N-10's VACUOUS_TEST stayed absent across 78 agent runs. But staging
#                   segment 0/3, and a NEW bookkeeping defect surfaced: N-12 (the "resolved" test
#                   only looked ONE layer deep), which killed run 2 outright
#   results/l1-m4k  L1-M4k  all three runs (E1x3 COMPLETED): PL-M19 (N-12) was NEITHER CONFIRMED
#                   NOR FALSIFIED - the branch never fired (zero `unresolved` rows), because all
#                   three runs died on slice-1 first. Staging segment 0/3. The three deaths were
#                   initially reported as `maxRetries` budget exhaustion; DB row-by-row review
#                   CORRECTED that: the budget was a RESULT, not the cause. The cause was N-13
#   results/l1-m4l  this batch (PL-M20 fixes N-13; see the headline watch item below)
#
# POLICY NOTE: PL-M18 changed the autonomy-L1 failure response from RETRY to REPLAN
# (failureStrategy "REPLAN" + allowReplan true), in BOTH packages/eval and packages/shared.
# **L1-M4l is therefore NOT strictly comparable with the 18 E1 runs that predate L1-M4j**
# (docs/184). It IS comparable with L1-M4j and L1-M4k, which ran on the same policy. The
# effective policy is written into every run JSON, so the batch self-documents the setting.
#
# QUOTA NOTE: the guard below computes the provider week from "now" (anchor 2026-10-11 23:00 UTC,
# 7-day cadence) instead of a hardcoded date. A hardcoded date would read an EMPTY window once the
# boundary passes while a stale one would read a closed window forever; computing it can do
# neither, and it is strictly stricter before the boundary (it keeps reading the current week).
#
# STOP-LINE: 400,000,000, the value the user authorised on 2026-10-18 (docs/184 errata block),
# replacing the original 200M line. Override with L1_M4L_GUARD_LIMIT if that ruling has changed.
#
# Contract is otherwise identical to l1-m4k-e1-x3.sh so the staging-segment numbers stay
# comparable in shape with the eleven earlier attempts.
#
# Watch items for this batch:
#   1. THE PL-M20 HEADLINE (N-13). In L1-M4k the defeat signature was: a task whose SCOPED AC all
#      passed (`acResults` shows passed, no failures) but whose `test` check recorded
#      `timedOut: true` after 2 x 120s attempts. 7 such tasks existed, and all 3 run deaths were
#      this. **Two things must now be true:**
#        (a) POSITIVE CONTROL - the scoped command must carry the new flag. If it does not, the
#            fix is NOT live and every other reading below is meaningless:
#              SELECT DISTINCT c->>'command'
#              FROM tasks t, jsonb_array_elements(t.output->'verification'->'checks') c
#              WHERE t.created_at >= '<batch start>' AND c->>'command' LIKE '%test-name-pattern%';
#            Expect `--test-timeout=100000` on the end of every such command.
#        (b) the L1-M4k defeat signature must NOT recur:
#              SELECT t.task_key, c->>'name', c->>'timedOut', c->>'failureCode', c->'acResults'
#              FROM tasks t, jsonb_array_elements(t.output->'verification'->'checks') c
#              WHERE t.created_at >= '<batch start>' AND (c->>'timedOut')::boolean IS TRUE;
#            A row here with a non-null `acResults` is the OLD defect. A row here carrying
#            `failureCode = 'CHECK_TIMEOUT'` is the NEW, BOUNDED behaviour (the file-level
#            100s bound fired) - that is a DIFFERENT and much less severe thing: the command
#            returned a verdict instead of eating the whole 120s budget twice. Report which.
#   2. N-12 (PL-M19) is STILL UNTESTED. L1-M4k produced ZERO rows with `unresolved` in
#      `error->>'message'`, so the two-layer resolution branch never ran. Watch again:
#        SELECT t.task_key, t.status, r.task_key AS resolved_by, r.status AS resolver_status
#        FROM tasks t LEFT JOIN tasks r ON r.id = t.resolved_by_task_id
#        WHERE t.workflow_run_id = '<wf>' AND t.status <> 'SUCCESS' ORDER BY t.created_at;
#      Any chain whose LAST element is SUCCESS, in a workflow that still ended FAILED with
#      "Workflow contains unresolved failed tasks", is a N-12 regression - stop and report.
#   3. The BACKEND `checks failed: test` wall: the top recurring defeat in L1-M4j AND L1-M4k.
#      NOTE - in L1-M4k this wall was LARGELY N-13 ITSELF (the hang masqueraded as a test
#      failure). If it persists at the same rate now, that is informative: it would mean real
#      test failures exist underneath the hang and N-13 was hiding them.
#        SELECT created_at::time(0), payload->>'taskType', payload->>'reason'
#        FROM workflow_events WHERE event_type='TASK_VERIFICATION'
#          AND payload->>'verdict'='failed' AND created_at >= '<batch start>';
#   4. `maxRetries` BUDGET EXHAUSTION: NOT a defect - it is the policy's declared depth budget.
#      In L1-M4k it was a SYMPTOM of N-13 (each attempt burned the timeout). If it persists
#      without N-13, the question is whether maxRetries 2 is the right budget, not whether the
#      engine is wrong.
#   5. N-6 must stay ABSENT (PL-M17): SELECT count(*) FROM agent_runs
#      WHERE created_at >= '<batch start>' AND error::text LIKE '%reasoning_content%';
#   6. N-9 must stay ABSENT (PL-M16): zero `agent_action` events with action `tool_call_requested`:
#        SELECT payload->>'action', count(*) FROM workflow_events
#        WHERE event_type='agent_action' GROUP BY 1;
#   7. N-8 must stay ABSENT (PL-M15): the count of `input_tokens > 10M` must not grow (11).
#   8. N-7 must stay ABSENT: "Recursion limit of 25 reached without hitting a stop condition".
#   9. The other N-6 400 must stay ABSENT: "tool message content must be a string on the gRPC path".
#  10. N-10 must stay ABSENT: `VACUOUS_TEST` / `EVIDENCE_MISSING`. That is WEAK evidence (the
#      condition may simply not have been exercised) - a reappearance is informative, not a
#      surprise. NOTE: PL-M20 ADDED `CHECK_TIMEOUT` to the same enum, so this batch can now
#      DISTINGUISH the three codes for the first time.
#  11. scopeViolations should stay 0 (PL-M12).
#  12. EMPTY_FINAL_ANSWER frequency (5 rows in L1-M4h, 1 in L1-M4i, 1 in L1-M4j; mechanism unknown).
#  13. Reaching the delivery slice ui-deploy-docs would be the FIRST real test of PL-M11 / PL-M12.
#  14. The seven L1-M4k same-batch observations are UNFIXED BY DESIGN (docs/187 sec.7 item 6:
#      register only, fix none). Watch whether any of them becomes the binding constraint:
#      backend-agent write scope vs tests/, replan routing non-convergence, `run_unit_test`
#      script-only policy, the dual server entry, `store.mjs` synchronous busy-wait, the AC-06
#      fixture defect.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4l-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4l-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4l"
mkdir -p "$OUT_DIR"

# Provider week boundary: anchor 2026-10-11 23:00 UTC, 7-day cadence, computed from "now".
# Anchor epoch 1791759600. See the QUOTA NOTE above for why this is computed, not hardcoded.
week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${L1_M4L_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${L1_M4L_GUARD_LIMIT:-400000000}"             # 400M = user-authorised line, 2026-10-18
COOLDOWN_SECS="${L1_M4L_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4L_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4L_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4L_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4L_E1_X3_ALL_COMPLETE"
