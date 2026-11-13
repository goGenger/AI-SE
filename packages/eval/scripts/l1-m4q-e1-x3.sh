#!/usr/bin/env bash
# L1-M4q acceptance batch: the SEVENTEENTH attempt at the E1 full-chain x3 batch for the L1-8
# acceptance item (docs/154 sec.3 M4), and the REAL-BATCH VERIFICATION of PL-M27 (N-26) plus the
# still-unverified PL-M25 judgement 26d and PL-M26.
#
# WHAT IS NEW THIS BATCH (PL-M27 / N-26, record docs/208):
#   `command-filter` scoping was NOT isolating. `--test-name-pattern` only filters TEST NAMES;
#   `node --test` still loads EVERY file under test/ and runs its top-level hooks
#   (taskVerifierRules.ts:301 says exactly this). So a SIBLING slice's test file whose hook fails
#   (typically ERR_SERVER_NOT_RUNNING because its endpoint is not implemented yet) makes the whole
#   command exit non-zero while THIS slice's ACs all pass - and the old rule
#   (`last.success && allRelevantPassed` at the slice boundary; `achieved = result.success` for the
#   task-level test check) failed the slice anyway. L1-M4p run 1 died exactly this way (`T-008`,
#   `# tests 10 / pass 7 / fail 3`, all 3 failures being sibling `hookFailed`, AC-01 itself green).
#   FIX: both verdict sites now accept "this slice's ACs all passed" for BOTH scoping modes, as
#   result-filter already did. Guarded by `!timedOut` - a TIMED-OUT command is still a failure
#   (`CHECK_TIMEOUT`), because a hung run's partial output is not evidence. The vacuity guard
#   (`relevant.length > 0`, N-10) is UNCHANGED. The scoped COMMAND itself was not touched.
#
# This batch REPLACES the aborted L1-M4o attempt. l1-m4o stopped after run 1 because the upstream
# provider went into a 429 outage (docs/203); it verified NOTHING. Per the repo convention (one
# results dir per attempt, so runs are never mixed across platform versions) this is a NEW dir.
#
# WHAT IS UNDER TEST (two phases, neither yet verified in a real batch):
#   PL-M25 (taskbooks docs/199 / docs/200, record docs/202) - two fixes, both found by L1-M4n:
#     N-22  `REPLAN` is a declared first-class outcome (outcomeSchema.ts:43) but the router only
#           read `fixTaskType`, which was reachable for qa-agent ONLY -> every other agent's
#           `REPLAN` request was structurally unreachable and the task was failed with NO error
#           code and NO verification record. Fix: root `fixTaskType` declared in the schema, four
#           statuses given one-line semantics in the prompt, `REPLAN_CONSTRAINT` attached to SIX
#           agents, executor reads the root field, and a REPLAN-outcome failure now carries
#           `REPLAN_REQUESTED`.
#     N-23  `debugTargetType` replaced a DELIVERY task's type with a work type, silently voiding
#           `input.delivery` (DeliveryOrchestrator.canHandle keys on `task.type`). L1-M4n run 3:
#           T7 (BUILD/CI) -> T7-REPLAN-1 (BACKEND) wrote NO `ci_runs` yet reported SUCCESS, and the
#           downstream T8 (DEPLOY) died on CI_RELEASE_NOT_FOUND. Fix: short-circuit delivery types
#           before the step-3 fallback (AFTER step 1, so N-22's channel is not immediately ignored).
#     Also: `failedTaskOutput` makes the platform's known error code land on the task output, not
#           only on the TASK_FAILED event (L1-M4n run 2 had `CI_FAILED` on the event and an EMPTY
#           `output.errorType` on the task).
#   PL-M26 (taskbook docs/204, record docs/205) - N-24, found BY the l1-m4o abort:
#     `ProfessionalAgent` classified an empty final answer as `EMPTY_FINAL_ANSWER` while checking
#     ONLY `TIMEOUT_ERROR`, so an upstream failure (`AgentGraph` ends a failed model call with
#     status "failed" + error.code "LLM_ERROR") was recorded as an AGENT-side empty answer. In
#     l1-m4o run 1 all 5 such tasks were upstream 429s and one run lasted ONE SECOND. Fix: a
#     "run failed" branch inserted BEFORE the empty-answer branch; `errorType` takes the existing
#     `RuntimeErrorCode` (NO new vocabulary); wording is fixed and does NOT echo upstream text.
#     A TRUE empty answer still records `EMPTY_FINAL_ANSWER` (negative control 27b).
#
# Batch history (each attempt is a separate results dir so runs are never mixed across
# platform versions - see docs/164 sec.7 item 4, docs/168 sec.7 item 7, docs/170 sec.7 item 8,
# docs/179 sec.7 item 5, docs/201):
#   results/l1-m4    PL-M4   run 1 only (aborted: slice-outside red test killed the slice's dev task)
#   results/l1-m4b  L1-M4b  run 1 only (aborted: N-2 - the scaffold task could not write the repo root)
#   results/l1-m4c  L1-M4c  runs 1-2 (aborted: run 2 reached the FINAL slice then died on N-4)
#   results/l1-m4d  L1-M4d  runs 1-2 (aborted: both runs died on N-6, the gateway 400s)
#   results/l1-m4e  L1-M4e  run 1 only (aborted after 9 minutes: LangGraph recursionLimit 25)
#   results/l1-m4f  L1-M4f  runs 1-2 (aborted: N-8 poisoned the weekly quota guard)
#   results/l1-m4g  L1-M4g  run 1 only (aborted: PL-M15 CONFIRMED, run died on the FIRST task, N-9)
#   results/l1-m4h  L1-M4h  all three runs: PL-M16 CONFIRMED, run 3 reached slice-3
#   results/l1-m4i  L1-M4i  runs 1-2 (aborted by the budget guard): first entry into slice-4
#   results/l1-m4j  L1-M4j  all three runs: PL-M18 CONFIRMED (18 dynamic tasks), N-12 surfaced
#   results/l1-m4k  L1-M4k  all three runs: PL-M19 NEITHER CONFIRMED NOR FALSIFIED (branch never
#                   fired); the deaths were N-13 (initially misattributed to budget exhaustion)
#   results/l1-m4l  L1-M4l  all three runs: PL-M20 CONFIRMED; new wall = anti-tamper (N-14)
#   results/l1-m4m  L1-M4m  all three runs: PL-M21 CONFIRMED; staging segment 1/3 - the FIRST
#                   staging success in the L1-M4x series (run 2 chained four slices)
#   results/l1-m4n  L1-M4n  all three runs: SIX fixes all CONFIRMED (N-18/N-19/PL-M24(1)/N-20/
#                   N-15'/N-21) and the FIRST ORACLE PASS of the whole L1-M4x series (run 3,
#                   `oraclePassed: true` / `falseNegative: true`, 13 directories x 31 runs were all
#                   0 before). staging segment 0/3. Two NEW defects found and fixed as PL-M25
#                   (N-22 run 2, N-23 run 3). docs/201
#   results/l1-m4o  L1-M4o  run 1 only (ABORTED: upstream 429 outage; 5 of 16 agent runs returned
#                   429 and were mis-recorded as EMPTY_FINAL_ANSWER -> N-24, fixed as PL-M26).
#                   PL-M25 was NOT verified. docs/203 / docs/204 / docs/205
#   results/l1-m4p  L1-M4p  all three runs, but **26d NOT reached** (0 `input.delivery` tasks,
#                   0 `ci_runs`). Six secondary judgements CONFIRMED in a real batch (25e(a),
#                   25e(b) - 16 FAILED tasks, 0 with an empty errorType - 25f, 25g, 27a, 27b) plus
#                   N-23's delivery short-circuit on TEST. Deaths: run 1 = NEW defect N-26
#                   (command-filter not isolating, slice 1, 33 min); run 2 = upstream 429 x4
#                   (slice 2 `task-core`, 73 min, its first workflow SUCCEEDED); run 3 = upstream
#                   429 x2 (slice 1, 7 min - effectively invalid). docs/207
#   results/l1-m4q  this batch (PL-M27/N-26 verification + the still-unverified 26d)
#
# POLICY NOTE: PL-M18 changed the autonomy-L1 failure response from RETRY to REPLAN
# (failureStrategy "REPLAN" + allowReplan true), in BOTH packages/eval and packages/shared.
# **This batch is NOT strictly comparable with the 18 E1 runs that predate L1-M4j** (docs/184).
# It IS comparable in SHAPE with L1-M4j..L1-M4n, which ran on the same policy.
#
# READINGS THAT CHANGED THIS BATCH (do NOT compare these with earlier batches):
#   * N-22's `REPLAN_REQUESTED` code and `failedTaskOutput` BOTH change the eval summary's
#     `errorTypes` distribution. L1-M4n reported ONE errorType for FOUR FAILED tasks (run 2) and
#     ONE for FIVE (run 3) because empty codes were dropped (harness.ts:73-75). After this batch
#     the same tasks carry codes. **A HIGHER reported-failure count here is the accounting gate
#     working, not a regression** - recompute from `tasks` before believing any attribution
#     (memory: batch-attribution-needs-db-verification).
#   * PL-M26 changes how an upstream model failure is CLASSIFIED: such a run now records
#     `LLM_ERROR` instead of `EMPTY_FINAL_ANSWER`. **`EMPTY_FINAL_ANSWER` should drop and
#     `LLM_ERROR` should appear**; neither reading alone is a defect signal.
#   * The replan ROUTING changed: a failed DELIVERY task (BUILD/DEPLOY/TEST) now keeps its type,
#     and a `REPLAN` outcome can now name its own type. **The shape of dynamic `-REPLAN-` /
#     `-DEBUG-` task chains is not comparable with earlier batches.**
#   * The agent prompts changed (four statuses got semantics, six agents got REPLAN_CONSTRAINT).
#     A change in `outcomeMode` / `REPLAN` frequency must be read against that, not against a
#     platform defect.
#
# QUOTA NOTE: the guard below computes the provider week from "now" (anchor 2026-10-11 23:00 UTC,
# 7-day cadence) instead of a hardcoded date. A hardcoded date would read an EMPTY window once the
# boundary passes while a stale one would read a closed window forever; computing it can do
# neither, and it is strictly stricter before the boundary (it keeps reading the current week).
# MEASURED BEFORE LAUNCH: 381,113,222 / 700,000,000 used (54.4%), window starting 2026-10-18 23:00
# UTC. **The user ruled on 2026-10-21: "do not watch the token limit, just start the task
# normally"** -> the guard is 700,000,000 so all three runs can complete in this window (a full
# E1x3 costs ~170M). This is the USER'S ruling, recorded here; the original 400M line came from the
# same user on 2026-10-18 (docs/184 errata block).
# CAVEAT (docs/198 sec.3, CORRECTED by docs/198 sec.16.4): this guard sums
# `agent_runs.token_usage` only. The PLANNING agent (807 runs) records NO usage at all, so the
# planning segment is structurally invisible to it. The delivery orchestrator is NOT a gap - it
# calls no language model, so it has no tokens to record. The guard never fails OPEN - it just
# cannot see the planning segment.
#
# STOP-LINE: 700,000,000, per the user's 2026-10-21 ruling (see QUOTA NOTE). Override with
# L1_M4Q_GUARD_LIMIT if that ruling has changed.
#
# Contract is otherwise identical to l1-m4n-e1-x3.sh so the staging-segment numbers stay
# comparable in shape with the fifteen earlier attempts.
#
# Watch items for this batch:
#   1. *** THE MAIN CRITERION (docs/200 sec.3, judgement 26d) *** - a failed CI task must, after
#      replan, still be a BUILD task AND write a `ci_runs` row; a downstream DEPLOY must NOT fail
#      with CI_RELEASE_NOT_FOUND. BEFORE (L1-M4n run 3): T7(BUILD/CI) -> T7-REPLAN-1(BACKEND),
#      zero ci_runs, T8 died on CI_RELEASE_NOT_FOUND.
#        SELECT t.task_key, t.type, t.input->'delivery'->>'action' AS action, t.status,
#               ar.input->>'runtime' AS runtime
#        FROM tasks t LEFT JOIN agent_runs ar ON ar.task_id = t.id
#        WHERE t.created_at >= '<batch start>' AND t.input ? 'delivery'
#        ORDER BY t.created_at;
#      And the CI rows themselves (a replan'd CI task MUST appear here with SUCCESS):
#        SELECT cr.id, t.task_key, t.type, cr.status, cr.created_at
#        FROM ci_runs cr LEFT JOIN tasks t ON t.id = cr.task_id
#        WHERE cr.created_at >= '<batch start>' ORDER BY cr.created_at;
#      And the staging segment per workflow:
#        SELECT w.id, count(*) FILTER (WHERE t.type='BUILD' AND t.input->'delivery'->>'action'='CI'
#                 AND t.status='SUCCESS') AS ci_ok,
#               count(*) FILTER (WHERE t.type='DEPLOY' AND t.input->'delivery'->>'action'='DEPLOY'
#                 AND t.status='SUCCESS') AS deploy_ok,
#               count(*) FILTER (WHERE t.type='TEST' AND t.input->'delivery'->>'action'='VERIFY'
#                 AND t.status='SUCCESS') AS verify_ok
#        FROM workflow_runs w JOIN tasks t ON t.workflow_run_id=w.id
#        WHERE w.created_at >= '<batch start>' GROUP BY w.id ORDER BY w.created_at;
#   2. *** N-22 JUDGEMENT 25f (positive control) *** - a `REPLAN` outcome that DOES name a type
#      must produce that type. Look for a `-REPLAN-` task whose type differs from its source:
#        SELECT t.task_key, t.type, src.type AS source_type, t.status, t.input->>'targetTaskType'
#        FROM tasks t JOIN tasks src ON src.id = t.source_task_id
#        WHERE t.created_at >= '<batch start>' AND t.task_key LIKE '%-REPLAN-%'
#        ORDER BY t.created_at;
#   3. *** N-22 JUDGEMENT 25g (negative control) *** - a `REPLAN` outcome WITHOUT a type must
#      behave as before (step-3 fallback). If EVERY replan now names a type, the fallback is
#      untested this batch - say so rather than claiming it holds.
#   4. *** N-22 JUDGEMENT 25e *** - two readings, both must improve:
#      (a) a `REPLAN`-outcome failure now carries `REPLAN_REQUESTED`:
#        SELECT t.task_key, t.type, t.output->>'outcome' AS outcome,
#               coalesce(t.output->>'errorType','(EMPTY)') AS error_type
#        FROM tasks t WHERE t.created_at >= '<batch start>' AND t.output->>'outcome' = 'REPLAN';
#      (b) **`status='FAILED'` tasks with an EMPTY `output.errorType` must drop to ~0** - this is
#      the `failedTaskOutput` half (L1-M4n run 2: 3 of 4 empty; run 3: 4 of 5 empty):
#        SELECT count(*) AS failed_total,
#               count(*) FILTER (WHERE t.output->>'errorType' IS NULL) AS failed_without_code
#        FROM tasks t WHERE t.created_at >= '<batch start>' AND t.status = 'FAILED';
#      Any residual empty code must be traced to a path that sets no `result.error.code` at all
#      BEFORE being called a defect.
#   5. *** N-24 / PL-M26 (docs/204 sec.3, judgement 27a) *** - the new positive control is that an
#      UPSTREAM failure must now be recorded as `LLM_ERROR`, NOT `EMPTY_FINAL_ANSWER`. The two
#      readings to take together:
#        SELECT ar.id, ar.status, ar.error->>'code' AS err_code,
#               ar.error->>'message' AS err_msg,
#               ar.created_at, ar.finished_at,
#               extract(epoch FROM (ar.finished_at - ar.created_at))::int AS secs
#        FROM agent_runs ar
#        WHERE ar.created_at >= '<batch start>' AND ar.error IS NOT NULL
#        ORDER BY ar.created_at;
#        SELECT t.task_key, coalesce(t.output->>'errorType','(EMPTY)') AS error_type, count(*)
#        FROM tasks t WHERE t.created_at >= '<batch start>' AND t.status='FAILED'
#        GROUP BY 1,2 ORDER BY 3 DESC;
#      PASS = every run whose `error->>'code'` is `LLM_ERROR` is reflected as such downstream, and
#      `EMPTY_FINAL_ANSWER` appears ONLY where the model truly returned an empty answer.
#      **WATCH THE SUB-SECOND RUNS**: in l1-m4o a 1-second run was recorded as "the agent kept
#      returning empty answers" - a run that short CANNOT have made a real attempt.
#   6. *** THE 429 CENSUS ITEM (docs/204 sec.7 ruling 1) *** - if `EMPTY_FINAL_ANSWER` still
#      appears, check whether its `agent_runs.error` carries a 429 before calling it a platform
#      defect. This is the accounting rule that was missing when the code was first registered
#      with "mechanism unknown":
#        SELECT t.task_key, t.output->>'errorType' AS error_type,
#               ar.error->>'code' AS run_err_code,
#               left(ar.error->>'message', 80) AS run_err_msg
#        FROM tasks t LEFT JOIN agent_runs ar ON ar.task_id = t.id
#        WHERE t.created_at >= '<batch start>' AND t.output->>'errorType' = 'EMPTY_FINAL_ANSWER';
#      Also, BEFORE reading anything else: confirm the upstream was healthy for the whole batch.
#      A degraded provider invalidates the batch (docs/203) - check the probe line at the top of
#      this file's launch record, and re-probe if the failure count looks abnormal.
#   7. The six fixes from L1-M4n must STILL hold (they are now the regression fence, not the
#      subject): `scripts/` write denials = 0 (N-18); `denied='write'` structured (N-19);
#      no sandbox-killed scoped check (PL-M24(1)); summary `errorTypes` reconciled against `tasks`
#      (N-20 - but see the READINGS NOTE above, the total WILL differ); zero
#      `no available checks for task type DEBUG` (N-15'); zero `TIMEOUT_ERROR` at 600s and, as the
#      positive control, any successful run near or above 600s (N-21).
#   8. THE MUST-STAY-ABSENT FAMILY (unchanged): N-6 `reasoning_content`; N-7 `Recursion limit of
#      25`; N-8 `input_tokens > 10M` must not grow; N-9 `agent_action` with action
#      `tool_call_requested`; N-10 `VACUOUS_TEST` / `EVIDENCE_MISSING`; `scopeViolations` = 0
#      (PL-M12). N-12 (PL-M19) has now been unexercised FOUR batches running - a chain whose LAST
#      element is SUCCESS in a workflow that still ended FAILED with "Workflow contains unresolved
#      failed tasks" is a regression: STOP AND REPORT.
#   9. THE STILL-OPEN REGISTRY ROW (docs/146 sec.3): the read side did NOT follow the write side -
#      `read_file Dockerfile` is still refused because `readPaths` carries no deliverables.
#  10. *** THE `docs/` WRITE SCOPE (sixth instance of write-scope-family-recurs) *** - L1-M4n
#      produced ONE denial (`DESIGN-TOKEN-AUTH-CONTRACT` writing `docs/design/token-auth-contract.md`)
#      but the task still SUCCEEDED, so it was NOT registered as a defect (no failing instance).
#      Watch whether it becomes BINDING this time:
#        SELECT coalesce(tc.input->>'path', tc.input->>'file_path') AS path, count(*)
#        FROM tool_calls tc JOIN agent_runs ar ON ar.id = tc.agent_run_id
#        WHERE ar.created_at >= '<batch start>'
#          AND tc.tool_name IN ('write_file','edit_file') AND tc.status = 'failed'
#        GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
#  11. N-23 ALSO HAS A DOWNSTREAM SHAPE WORTH WATCHING. VERIFIED 2026-10-21: a failed DEPLOY is
#      NEVER replan'd. `deployFailureStrategy` overrides the general `failureStrategy`
#      UNCONDITIONALLY (WorkflowEngine.ts:828-832 forces `strategy = "ROLLBACK"`, beating even
#      `routed?.strategy`), so a failed DEPLOY goes to the ROLLBACK branch (:895-899) and
#      `replan()` never runs. (The ROLLBACK branch additionally requires `input.delivery` to
#      parse - :898.) Any `ROLLBACK` task or `deployments` row with `operation='ROLLBACK'` is NEW
#      for the L1-M4x series (L1-M4m had one staging ROLLED_BACK in the whole DB) - report it
#      rather than calling it a regression.
#      CONSEQUENCE, so nobody re-derives it mid-batch: because failed DEPLOYs skip replan, the
#      `-DEBUG-` task can never be given `targetTaskType="DEPLOY"`, and therefore the fact that
#      `TASK_AGENT_TYPES` (AgentRegistry.ts:269-278) lists BUILD->DEVOPS and TEST->QA but NOT
#      DEPLOY is HARMLESS today. It would become a real defect the moment a policy runs without
#      `deployFailureStrategy: "ROLLBACK"`. Do not register it on shape alone.
#      FOR THE BUILD/CI CASE (watch item 1) THE ROUTING IS FINE: BUILD is in TASK_AGENT_TYPES
#      (-> DEVOPS), so a replan'd BUILD task's `-DEBUG-` companion is dispatchable.
#  12. The seven L1-M4k same-batch observations are UNFIXED BY DESIGN (docs/187 sec.7 item 6:
#      register only, fix none). Watch whether any becomes the binding constraint.
#  13. *** docs/200 sec.7.1 IS STILL OPEN *** - "a CI task that fails on a stale test needs a
#      TWO-STEP fix (repair the test, then re-run CI), and replan() creates ONE retry task".
#      Do NOT read a converged chain here as proof that both fixes are sufficient; and do NOT
#      read a non-convergent one as a regression of them. Report WHICH shape occurred.
#  14. *** N-26 / PL-M27 IS THIS BATCH'S VERIFICATION TARGET (docs/208, judgements 29a-29d) ***
#      PASS LOOKS LIKE: a task whose scoped `test` check has `exitCode: 1` (or `passed: false`
#      with non-zero exit) YET `acResults` shows EVERY scoped AC `passed`, and the task is
#      `SUCCESS` / `verified` - i.e. failures in the TAP that carry NO AC marker.
#        SELECT t.task_key, t.status, coalesce(t.output->>'errorType','(EMPTY)') AS err,
#               c->>'name' AS check, c->>'passed' AS passed, c->>'exitCode' AS exit_code,
#               c->>'scopingMode' AS scoping, c->'scopedAcKeys' AS keys,
#               c->'acResults' AS ac_results,
#               (c->>'stdoutTail') ~ 'hookFailed' AS sibling_hookfail
#        FROM tasks t, jsonb_array_elements(t.output->'verification'->'checks') c
#        WHERE t.created_at >= '<batch start>' AND c->>'scopingMode' = 'command-filter'
#        ORDER BY t.created_at;
#      READING IT: `exit_code != 0` AND all `ac_results` values `passed` AND the task is
#      `SUCCESS` => 29a holds (this is exactly what used to fail). Any `command-filter` check
#      that FAILED must be traced: if its scoped ACs genuinely failed => 29b holds (the rule still
#      discriminates); if NO AC result was parsed at all => 29c holds (the vacuity guard).
#      *** REGRESSION SIGNAL, STOP AND REPORT ***: a slice whose scoped ACs ALL PASSED still being
#      FAILED. That means the fix did not take - check FIRST that the server was restarted after
#      docs/208 (the fix is in apps/server/src; a stale process runs the old rule).
#      ALSO still-possible (known residual, docs/208 sec.7 items 2-3, deliberately NOT fixed):
#      scope has N ACs but only M<N appear in the TAP (the rest never ran) => may still pass; and
#      a SUCCESSFUL command is not checked for whether the scoped ACs ran at all. Report if either
#      becomes the binding shape rather than silently attributing it to this fix.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4q-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4q-stop.sh   (kills roles AND cancels server-side)
#          NOTE: l1-m4n-stop.sh does NOT cover this batch - its "[l]1-m4n" pattern cannot match
#          "l1-m4q", and killing only the cooldown sleep would ADVANCE the loop to the next run.
#          Use l1-m4q-stop.sh.
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4q"
mkdir -p "$OUT_DIR"

# Provider week boundary: anchor 2026-10-11 23:00 UTC, 7-day cadence, computed from "now".
# Anchor epoch 1791759600. See the QUOTA NOTE above for why this is computed, not hardcoded.
week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${L1_M4Q_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${L1_M4Q_GUARD_LIMIT:-700000000}"             # user ruling 2026-10-21 (see QUOTA NOTE)
COOLDOWN_SECS="${L1_M4Q_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4Q_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4Q_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4Q_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4Q_E1_X3_ALL_COMPLETE"
