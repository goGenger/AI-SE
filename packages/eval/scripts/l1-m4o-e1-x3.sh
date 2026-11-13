#!/usr/bin/env bash
# L1-M4o acceptance batch: the fifteenth attempt at the E1 full-chain x3 batch for the L1-8
# acceptance item (docs/154 sec.3 M4), and the REAL-BATCH VERIFICATION of PL-M25.
#
# PL-M25 carries TWO fixes (taskbooks docs/199 / docs/200, record docs/202), both found by the
# PREVIOUS batch (docs/201):
#   N-22  `REPLAN` is a declared first-class outcome (outcomeSchema.ts:43) but the router only
#         read `fixTaskType`, which was reachable for qa-agent ONLY -> every other agent's
#         `REPLAN` request was structurally unreachable and the task was failed with NO error
#         code and NO verification record. Fix: root `fixTaskType` declared in the schema, four
#         statuses given one-line semantics in the prompt, `REPLAN_CONSTRAINT` attached to SIX
#         agents, executor reads the root field, and a REPLAN-outcome failure now carries
#         `REPLAN_REQUESTED`.
#   N-23  `debugTargetType` replaced a DELIVERY task's type with a work type, silently voiding
#         `input.delivery` (DeliveryOrchestrator.canHandle keys on `task.type`). L1-M4n run 3:
#         T7 (BUILD/CI) -> T7-REPLAN-1 (BACKEND) wrote NO `ci_runs` yet reported SUCCESS, and the
#         downstream T8 (DEPLOY) died on CI_RELEASE_NOT_FOUND. Fix: short-circuit delivery types
#         before the step-3 fallback (AFTER step 1, so N-22's channel is not immediately ignored).
#   Also: `failedTaskOutput` makes the platform's known error code land on the task output, not
#         only on the TASK_FAILED event (L1-M4n run 2 had `CI_FAILED` on the event and an EMPTY
#         `output.errorType` on the task).
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
#   results/l1-m4o  this batch (PL-M25 verification)
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
# MEASURED BEFORE LAUNCH: 331,271,625 / 400,000,000 used (82.8%), window starting 2026-10-18 23:00
# UTC. **The user ruled on 2026-10-21: "do not watch the token limit, just start the task
# normally"** -> the default guard below is raised to 700,000,000 so all three runs can complete
# in this window (a full E1x3 costs ~170M). This is the USER'S ruling, recorded here; the original
# 400M line came from the same user on 2026-10-18 (docs/184 errata block).
# CAVEAT (docs/198 sec.3): this guard sums `agent_runs.token_usage` only. The planning agent (807
# runs) and the delivery orchestrator (23 runs) record NO usage at all, so the planning and
# delivery segments are structurally invisible to it. The guard never fails OPEN - it just cannot
# see those two segments.
#
# STOP-LINE: 700,000,000, per the user's 2026-10-21 ruling (see QUOTA NOTE). Override with
# L1_M4O_GUARD_LIMIT if that ruling has changed.
#
# Contract is otherwise identical to l1-m4n-e1-x3.sh so the staging-segment numbers stay
# comparable in shape with the fourteen earlier attempts.
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
#   5. The six fixes from L1-M4n must STILL hold (they are now the regression fence, not the
#      subject): `scripts/` write denials = 0 (N-18); `denied='write'` structured (N-19);
#      no sandbox-killed scoped check (PL-M24(1)); summary `errorTypes` reconciled against `tasks`
#      (N-20 - but see the READINGS NOTE above, the total WILL differ); zero
#      `no available checks for task type DEBUG` (N-15'); zero `TIMEOUT_ERROR` at 600s and, as the
#      positive control, any successful run near or above 600s (N-21).
#   6. THE MUST-STAY-ABSENT FAMILY (unchanged): N-6 `reasoning_content`; N-7 `Recursion limit of
#      25`; N-8 `input_tokens > 10M` must not grow; N-9 `agent_action` with action
#      `tool_call_requested`; N-10 `VACUOUS_TEST` / `EVIDENCE_MISSING`; `scopeViolations` = 0
#      (PL-M12); `EMPTY_FINAL_ANSWER` frequency. N-12 (PL-M19) has now been unexercised FOUR
#      batches running - a chain whose LAST element is SUCCESS in a workflow that still ended
#      FAILED with "Workflow contains unresolved failed tasks" is a regression: STOP AND REPORT.
#   7. THE STILL-OPEN REGISTRY ROW (docs/146 sec.3): the read side did NOT follow the write side -
#      `read_file Dockerfile` is still refused because `readPaths` carries no deliverables.
#   8. *** THE `docs/` WRITE SCOPE (sixth instance of write-scope-family-recurs) *** - L1-M4n
#      produced ONE denial (`DESIGN-TOKEN-AUTH-CONTRACT` writing `docs/design/token-auth-contract.md`)
#      but the task still SUCCEEDED, so it was NOT registered as a defect (no failing instance).
#      Watch whether it becomes BINDING this time:
#        SELECT coalesce(tc.input->>'path', tc.input->>'file_path') AS path, count(*)
#        FROM tool_calls tc JOIN agent_runs ar ON ar.id = tc.agent_run_id
#        WHERE ar.created_at >= '<batch start>'
#          AND tc.tool_name IN ('write_file','edit_file') AND tc.status = 'failed'
#        GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
#   9. N-23 ALSO HAS A DOWNSTREAM SHAPE WORTH WATCHING: after the fix, a failed DEPLOY that is
#      replan'd keeps `type = DEPLOY`, and `deployFailureStrategy = ROLLBACK` may then route it to
#      the ROLLBACK branch (WorkflowEngine.ts:866 requires `input.delivery` to parse). Any
#      `ROLLBACK` task or `deployments` row with `operation='ROLLBACK'` is NEW for the L1-M4x
#      series (L1-M4m had one staging ROLLED_BACK in the whole DB) - report it rather than
#      calling it a regression.
#  10. The seven L1-M4k same-batch observations are UNFIXED BY DESIGN (docs/187 sec.7 item 6:
#      register only, fix none). Watch whether any becomes the binding constraint.
#  11. *** docs/200 sec.7.1 IS STILL OPEN *** - "a CI task that fails on a stale test needs a
#      TWO-STEP fix (repair the test, then re-run CI), and replan() creates ONE retry task".
#      Do NOT read a converged chain here as proof that both fixes are sufficient; and do NOT
#      read a non-convergent one as a regression of them. Report WHICH shape occurred.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4o-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4o-stop.sh   (kills roles AND cancels server-side)
#          NOTE: l1-m4n-stop.sh does NOT cover this batch - its "[l]1-m4n" pattern cannot match
#          "l1-m4o", and killing only the cooldown sleep would ADVANCE the loop to the next run.
#          Use l1-m4o-stop.sh.
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4o"
mkdir -p "$OUT_DIR"

# Provider week boundary: anchor 2026-10-11 23:00 UTC, 7-day cadence, computed from "now".
# Anchor epoch 1791759600. See the QUOTA NOTE above for why this is computed, not hardcoded.
week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${L1_M4O_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${L1_M4O_GUARD_LIMIT:-700000000}"             # user ruling 2026-10-21 (see QUOTA NOTE)
COOLDOWN_SECS="${L1_M4O_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4O_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4O_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4O_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4O_E1_X3_ALL_COMPLETE"
