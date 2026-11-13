#!/usr/bin/env bash
# L1-M4m acceptance batch: the thirteenth attempt at the E1 full-chain x3 batch for the L1-8
# acceptance item (docs/154 sec.3 M4), now carrying the PL-M21 fixes on top of PL-M7..PL-M20:
#   N-14  anti-tamper gate now distinguishes ADDING tests from WEAKENING them (content-aware)
#   N-17  an `enforce` failure reason now reaches downstream/replanned tasks (compacted)
#   N-16  `sliceReached` no longer leaks across runs (read-side scoping)
#   noise line now compares against the previous run IN THE SAME DIRECTORY, not results/ root
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
#   results/l1-m4h  L1-M4h  all three runs: PL-M16 CONFIRMED - criterion 16h met, ZERO spin
#                   across 64 agent runs - and run 3 cleared slice-2 and reached slice-3 for the
#                   first time. But staging segment 0/3, N-6 recurred 5 times, and a new wall
#                   appeared (the core-implementation BACKEND task)
#   results/l1-m4i  L1-M4i  runs 1-2 (aborted by the budget guard before run 3): PL-M17 was
#                   CONFIRMED - N-6 stayed ABSENT across 76 agent runs - and run 2 went deeper
#                   than any run before (slices 1-3 all green, first entry into slice-4). But
#                   staging segment 0/2, and two NEW platform-side defeat points appeared:
#                   N-10 (TEST red-light scope fallback) and N-11 (REVIEW negative verdict)
#   results/l1-m4j  L1-M4j  all three runs: PL-M18 was CONFIRMED - N-11's REPLAN path was used
#                   heavily (18 dynamic tasks, where the whole database had ZERO before; 3
#                   failures cleanly rescued; the work-type fallback fired every time) and
#                   N-10's VACUOUS_TEST stayed absent across 78 agent runs. But staging segment
#                   0/3, and a NEW bookkeeping defect surfaced: N-12 (the "resolved" test only
#                   looked ONE layer deep), which killed run 2 outright
#   results/l1-m4k  L1-M4k  all three runs: PL-M19 (N-12) was NEITHER CONFIRMED NOR FALSIFIED -
#                   the branch never fired (zero `unresolved` rows), because all three runs died
#                   on slice-1 first. Staging segment 0/3. The three deaths were initially
#                   reported as `maxRetries` budget exhaustion; DB row-by-row review CORRECTED
#                   that: the budget was a RESULT, not the cause. The cause was N-13
#   results/l1-m4l  L1-M4l  all three runs: PL-M20 (N-13) was CONFIRMED - criterion 20g met,
#                   all 18 checks green, zero timeouts. But staging segment 0/3 and ZERO
#                   delivery tasks. **The sole defeat point was anti-tamper (N-14): 7 of 9
#                   FAILED tasks died on `protected test files modified: <path>` and all three
#                   run deaths landed there - while EVERY check that ran passed.** The other 2
#                   FAILED tasks were 600s agent timeouts (T-02 / T-02-DEBUG-1, slice S2)
#   results/l1-m4m  this batch (PL-M21 fixes N-14 / N-17 / N-16 + the noise line)
#
# POLICY NOTE: PL-M18 changed the autonomy-L1 failure response from RETRY to REPLAN
# (failureStrategy "REPLAN" + allowReplan true), in BOTH packages/eval and packages/shared.
# **L1-M4m is NOT strictly comparable with the 18 E1 runs that predate L1-M4j** (docs/184).
# It IS comparable with L1-M4j / L1-M4k / L1-M4l, which ran on the same policy.
#
# VERDICT-COMPARABILITY NOTE (NEW IN THIS BATCH): PL-M21 changed the anti-tamper criterion from
# "a protected test file's hash changed" to "a pre-existing assertion line disappeared". The
# failure reason string changed with it, from `protected test files modified:` to
# `protected test files weakened:`. **The anti-tamper death count is therefore NOT comparable
# with L1-M4l or any earlier batch.** The record now carries `antiTamper.changed` (files whose
# hash moved) AND `antiTamper.weakened` (the subset that lost an assertion), which is what makes
# "the gate was right" distinguishable from "the gate was wrong" for the first time.
#
# QUOTA NOTE: the guard below computes the provider week from "now" (anchor 2026-10-11 23:00 UTC,
# 7-day cadence) instead of a hardcoded date. A hardcoded date would read an EMPTY window once the
# boundary passes while a stale one would read a closed window forever; computing it can do
# neither, and it is strictly stricter before the boundary (it keeps reading the current week).
#
# STOP-LINE: 400,000,000, the value the user authorised on 2026-10-18 (docs/184 errata block),
# replacing the original 200M line. Override with L1_M4M_GUARD_LIMIT if that ruling has changed.
#
# Contract is otherwise identical to l1-m4l-e1-x3.sh so the staging-segment numbers stay
# comparable in shape with the twelve earlier attempts.
#
# Watch items for this batch:
#   1. THE PL-M21 HEADLINE (N-14). L1-M4l's sole defeat point was the anti-tamper gate: 7 of 9
#      FAILED tasks died on `protected test files modified:`, all three run deaths landed there,
#      and every check that ran passed. Row-by-row reading of the `edit_file` calls then showed
#      TWO KINDS of change mixed in one gate: T3-DEBUG-1 only added two imports (the gate was
#      WRONG) while T-02-DEBUG-1-DEBUG-2 replaced an `assert.throws(...)` demanding a minimum
#      key length with an `assert.equal(...)` accepting it (the gate was RIGHT).
#      **Three things must now be true:**
#        (a) POSITIVE CONTROL - the new rule must be live. If the OLD reason text still appears,
#            the fix is NOT loaded and every other reading below is meaningless:
#              SELECT t.task_key, t.output->'verification'->>'reason'
#              FROM tasks t
#              WHERE t.created_at >= '<batch start>'
#                AND t.output->'verification'->>'reason' LIKE 'protected test files%';
#            Expect either ZERO rows, or rows reading `protected test files weakened:`. A row
#            reading `protected test files modified:` means the fix is NOT live - STOP AND REPORT.
#        (b) ADDITIVE TOUCHES MUST NOT KILL. A dev task that only added tests/imports must now be
#            recorded `antiTamper.verdict = 'passed'` with a NON-EMPTY `changed` list:
#              SELECT t.task_key, t.status,
#                     t.output->'verification'->'antiTamper'->>'verdict',
#                     t.output->'verification'->'antiTamper'->'changed',
#                     t.output->'verification'->'antiTamper'->'weakened'
#              FROM tasks t
#              WHERE t.created_at >= '<batch start>'
#                AND t.output->'verification'->'antiTamper'->>'verdict' IS NOT NULL
#              ORDER BY t.task_key;
#            Rows with verdict `passed` + non-empty `changed` are the L1-M4l false positives now
#            correctly allowed through. Rows with verdict `failed` must have a non-empty
#            `weakened` - a `failed` row with an EMPTY `weakened` is a BUG in the new code.
#        (c) the L1-M4l defeat signature must NOT recur: no task may die with a reason starting
#            `protected test files modified:`.
#   2. N-17 (failure reason reaches replanned tasks). Not directly stored, so watch the EFFECT:
#      a task that dies the same way three times in a row (as happened in L1-M4l, where each
#      retry re-edited test files without ever learning it had been blocked) is the signature of
#      the reason NOT arriving. Count repeated deaths per task_key family:
#        SELECT regexp_replace(task_key, '-DEBUG-[0-9]+$|-REPLAN-[0-9]+$', '') AS family,
#               count(*) FROM tasks
#        WHERE created_at >= '<batch start>' AND status = 'FAILED' GROUP BY 1 HAVING count(*) > 1;
#   3. N-16 (sliceReached must not leak across runs). The eval now scopes the slice view to the
#      workflows THIS run drove. Verify against the DB, per run - do NOT trust the summary:
#        SELECT wr.id, wr.status, wr.created_at FROM workflow_runs wr
#        WHERE wr.created_at >= '<batch start>' ORDER BY wr.created_at;
#      run N's `sliceReached` must equal the last slice that actually has a workflow in that run's
#      time window. In L1-M4l the eval claimed S2 for all three runs while the DB said run 1 -> S2,
#      runs 2/3 -> S1.
#   4. The noise line (PL-M21). Each run-N-summary.md must compare against run N-1 IN THE SAME
#      DIRECTORY. In L1-M4l run 2 compared against an October batch in results/ root. Check:
#        grep -h 'noise' packages/eval/results/l1-m4m/run-*-summary.md
#   5. THE 600s AGENT TIMEOUT (the second real defeat point, UNFIXED). In L1-M4l, T-02 and
#      T-02-DEBUG-1 both timed out at 600s with `current_iteration = 66` against
#      `max_iterations = 50` - but 65 VARIED tool calls each (write_file / edit_file /
#      run_unit_test / run_lint / run_build / search_code ...), i.e. genuine work on a large
#      scaffold task, NOT a spin. Watch whether it recurs, and whether it always hits the same
#      kind of task (a big scaffold):
#        SELECT t.task_key, t.type, ar.current_iteration, ar.max_iterations,
#               round(extract(epoch from (ar.finished_at - ar.started_at))) AS secs,
#               (SELECT count(*) FROM tool_calls tc WHERE tc.agent_run_id = ar.id) AS calls
#        FROM tasks t JOIN agent_runs ar ON ar.task_id = t.id
#        WHERE ar.created_at >= '<batch start>' AND ar.status <> 'succeeded' ORDER BY t.task_key;
#   6. N-13 must stay ABSENT (PL-M20), with its positive control - the scoped command must still
#      carry `--test-timeout`:
#        SELECT DISTINCT c->>'command'
#        FROM tasks t, jsonb_array_elements(t.output->'verification'->'checks') c
#        WHERE t.created_at >= '<batch start>' AND c->>'command' LIKE '%test-name-pattern%';
#   7. N-12 (PL-M19) is STILL UNTESTED - L1-M4k and L1-M4l both produced ZERO `unresolved` rows.
#      Watch again; any chain whose LAST element is SUCCESS in a workflow that still ended FAILED
#      with "Workflow contains unresolved failed tasks" is a regression - stop and report.
#   8. N-6 must stay ABSENT (PL-M17): count of agent_runs with `reasoning_content` in error text.
#   9. N-7 must stay ABSENT: "Recursion limit of 25 reached without hitting a stop condition".
#  10. N-8 must stay ABSENT (PL-M15): the count of `input_tokens > 10M` must not grow (11).
#  11. N-9 must stay ABSENT (PL-M16): zero `agent_action` events with action `tool_call_requested`.
#  12. N-10 must stay ABSENT: `VACUOUS_TEST` / `EVIDENCE_MISSING` / `CHECK_TIMEOUT`.
#  13. scopeViolations should stay 0 (PL-M12).
#  14. EMPTY_FINAL_ANSWER frequency (5 rows in L1-M4h, 1 in L1-M4i, 1 in L1-M4j; mechanism unknown).
#  15. Reaching the delivery slice ui-deploy-docs would be the FIRST real test of PL-M11 / PL-M12.
#  16. The seven L1-M4k same-batch observations are UNFIXED BY DESIGN (docs/187 sec.7 item 6:
#      register only, fix none). Watch whether any of them becomes the binding constraint:
#      backend-agent write scope vs tests/, replan routing non-convergence, `run_unit_test`
#      script-only policy, the dual server entry, `store.mjs` synchronous busy-wait, the AC-06
#      fixture defect.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4m-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4m-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4m"
mkdir -p "$OUT_DIR"

# Provider week boundary: anchor 2026-10-11 23:00 UTC, 7-day cadence, computed from "now".
# Anchor epoch 1791759600. See the QUOTA NOTE above for why this is computed, not hardcoded.
week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${L1_M4M_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${L1_M4M_GUARD_LIMIT:-400000000}"             # 400M = user-authorised line, 2026-10-18
COOLDOWN_SECS="${L1_M4M_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4M_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4M_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4M_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4M_E1_X3_ALL_COMPLETE"
