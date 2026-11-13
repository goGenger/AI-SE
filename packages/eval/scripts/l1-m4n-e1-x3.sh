#!/usr/bin/env bash
# L1-M4n acceptance batch: the fourteenth attempt at the E1 full-chain x3 batch for the L1-8
# acceptance item (docs/154 sec.3 M4), carrying SIX fixes that have never been exercised in a
# real batch:
#   N-18  PL-M22  `scripts/` (and bin/.github/Makefile) are writable; the audit side DERIVES its
#                 path table from writePathsForTaskType("BUILD") instead of hand-copying it
#   N-19  PL-M23  a denied write is recorded structurally (`tool_calls.input.denied`), and
#                 `WriteScopeAudit` carries deniedAttempts / deniedPaths
#   N-13  PL-M24  the scoped command's `--test-timeout` now spans N never-completing files
#                 (100000 -> 20000 at the default budget), not just one
#   N-20          `errorTypes` counts ONE granularity (task level), not two summed together
#   N-15'         a DEBUG task takes its checks from `input.targetTaskType` instead of being
#                 unconditionally `unavailable`
#   N-21          the task wall-clock budget is 900s (was 600s)
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
#                   delivery tasks. The sole defeat point was anti-tamper (N-14): 7 of 9 FAILED
#                   tasks died on `protected test files modified: <path>` and all three run
#                   deaths landed there - while EVERY check that ran passed. The other 2 FAILED
#                   tasks were 600s agent timeouts (T-02 / T-02-DEBUG-1, slice S2)
#   results/l1-m4m  L1-M4m  all three runs: PL-M21 CONFIRMED on its (A) half (an additive touch
#                   now passes where it used to die). **staging segment 1/3 - the FIRST staging
#                   success in the L1-M4x series** (run 2 chained four slices: 4860c374 ->
#                   48cd16a5 -> f45b6eb9 -> 716eb98d, CI + staging DEPLOY + staging VERIFY all
#                   green). PL-M20's criterion 20g was DOWNGRADED here: run 3 produced
#                   CHECK_TIMEOUT x7 on commands that DID carry `--test-timeout=100000`, so the
#                   "bounded failure" guarantee did not hold at production values
#   results/l1-m4n  this batch (N-18 / N-19 / PL-M24(1) / N-20 / N-15' / N-21)
#
# POLICY NOTE: PL-M18 changed the autonomy-L1 failure response from RETRY to REPLAN
# (failureStrategy "REPLAN" + allowReplan true), in BOTH packages/eval and packages/shared.
# **This batch is NOT strictly comparable with the 18 E1 runs that predate L1-M4j** (docs/184).
# It IS comparable in SHAPE with L1-M4j / L1-M4k / L1-M4l / L1-M4m, which ran on the same policy.
#
# READINGS THAT CHANGED THIS BATCH (do NOT compare these four numbers with earlier batches):
#   * N-21 moved the task wall clock 600s -> 900s. A run that used to die at 600s now either
#     finishes or dies at 900s. **The TIMEOUT_ERROR count is not comparable** - and if timeouts
#     merely MOVE to 900s, the correct conclusion is that the tail is long and the fix must be
#     task-splitting on the planning side (docs/197 sec.11 item 2).
#   * PL-M24 changed the scoped command string: `--test-timeout` is now 20000 at the default
#     budget (was 100000). **The `command` field is not byte-comparable with earlier batches.**
#   * N-20 changed the eval summary's accounting: `errorTypes` now counts ONE granularity.
#     **The summary `errorTypes` / `failureLayers` are not comparable** - recompute from `tasks`
#     and `agent_runs` before believing any batch attribution (memory: batch-attribution-needs-
#     db-verification).
#   * N-15' changed DEBUG verification: DEBUG tasks now take checks from `input.targetTaskType`.
#     **The `verificationUnavailable` count must DROP** - see watch item 2 for the positive control.
#
# QUOTA NOTE: the guard below computes the provider week from "now" (anchor 2026-10-11 23:00 UTC,
# 7-day cadence) instead of a hardcoded date. A hardcoded date would read an EMPTY window once the
# boundary passes while a stale one would read a closed window forever; computing it can do
# neither, and it is strictly stricter before the boundary (it keeps reading the current week).
# MEASURED BEFORE LAUNCH: 160,297,518 / 400,000,000 used (40%), window starting 2026-10-18 23:00 UTC.
# CAVEAT (docs/198 sec.3): this guard sums `agent_runs.token_usage` only. The planning agent (807
# runs) and the delivery orchestrator (23 runs) record NO usage at all, so the planning and
# delivery segments are structurally invisible to it. The guard never fails OPEN - it just cannot
# see those two segments.
#
# STOP-LINE: 400,000,000, the value the user authorised on 2026-10-18 (docs/184 errata block),
# replacing the original 200M line. Override with L1_M4N_GUARD_LIMIT if that ruling has changed.
#
# Contract is otherwise identical to l1-m4m-e1-x3.sh so the staging-segment numbers stay
# comparable in shape with the thirteen earlier attempts.
#
# Watch items for this batch:
#   1. N-21 POSITIVE CONTROL - the wall clock must actually be 900s. A run that dies at 600s
#      means the new default is NOT loaded (the :47558 instance was NOT restarted). STOP AND
#      REPORT - every other reading below would be meaningless:
#        SELECT t.task_key, t.type,
#               round(extract(epoch from (ar.finished_at - ar.started_at))) AS secs,
#               ar.current_iteration, ar.max_iterations
#        FROM tasks t JOIN agent_runs ar ON ar.task_id = t.id
#        WHERE ar.created_at >= '<batch start>' AND ar.error->>'code' = 'TIMEOUT_ERROR'
#        ORDER BY ar.created_at;
#      Also count the COMPETING limit, because N-21 is only meaningful if the wall clock binds
#      first (docs/197 sec.2.5):
#        SELECT count(*) FILTER (WHERE error->>'code' = 'TIMEOUT_ERROR') AS timeouts,
#               count(*) FILTER (WHERE error->>'message' LIKE '%max iterations%') AS max_iters
#        FROM agent_runs WHERE created_at >= '<batch start>';
#      Watch item 5 of L1-M4m (the 600s timeout) is now THIS item. Also watch the STALL shape
#      (docs/197 sec.11 item 3): a run whose LAST tool call is more than 120s before its end is
#      a stall, not a budget-bound run, and belongs to a different (unregistered) family:
#        SELECT t.task_key, ar.current_iteration,
#               round(extract(epoch from (ar.finished_at - (SELECT max(tc.started_at)
#                 FROM tool_calls tc WHERE tc.agent_run_id = ar.id)))) AS tail_s
#        FROM tasks t JOIN agent_runs ar ON ar.task_id = t.id
#        WHERE ar.created_at >= '<batch start>' AND ar.error->>'code' = 'TIMEOUT_ERROR';
#   2. N-15' POSITIVE CONTROL - `no available checks for task type DEBUG` must DROP to ~zero.
#      If it is still the dominant reason on DEBUG tasks, the fix is NOT loaded:
#        SELECT t.output->'verification'->>'reason' AS reason, count(*)
#        FROM tasks t
#        WHERE t.created_at >= '<batch start>' AND t.type = 'DEBUG'
#        GROUP BY 1 ORDER BY 2 DESC;
#      Expect DEBUG tasks to now carry REAL checks (build / test) taken from their
#      `input.targetTaskType`. A DEBUG task that still reads `unavailable` needs its
#      `input.targetTaskType` inspected before calling it a failure.
#   3. N-18 / N-19 POSITIVE CONTROLS - denied writes are now STRUCTURED, and `scripts/` is
#      writable. Run the census FIRST (it was a precondition for launching):
#        SELECT tc.input->>'path' AS path, count(*)
#        FROM tool_calls tc JOIN tasks t ON t.id = tc.task_id
#        WHERE tc.input->>'denied' = 'write' AND t.created_at >= '<batch start>'
#        GROUP BY 1 ORDER BY 2 DESC;
#      In L1-M4m the same shape query gave scripts/selfcheck.mjs x7, scripts/verify-contract.mjs
#      x5, docs/ac-coverage.md x3. **`scripts/` must now be ABSENT or near-zero** (devops-agent's
#      writePaths gained it). A row with `denied` NULL where a write was clearly refused means
#      N-19's structural marker is NOT loaded. Also confirm the audit side carries the new fields:
#        SELECT t.task_key, t.output->'verification'->'writeScope'->>'deniedAttempts',
#               t.output->'verification'->'writeScope'->'deniedPaths'
#        FROM tasks t WHERE t.created_at >= '<batch start>'
#          AND t.output->'verification'->'writeScope' IS NOT NULL LIMIT 20;
#      scopeViolations must stay 0 (PL-M12) - N-18's derived table must not have LOOSENED it.
#      *** THE NEXT WALL IS `docs/` (predicted before launch, 2026-10-20) ***. The census run
#      before this batch (restricted to write_file/edit_file failures in the L1-M4m window) gave:
#        scripts/selfcheck.mjs 7 | scripts/verify-contract.mjs 5 | scripts/lint.mjs 4
#        scripts/typecheck.mjs 3 | scripts/build.mjs 2   <- all addressed by N-18
#        docs/ac-coverage.md 3 | docs/S2-architecture.md 1   <- NOT addressed by anything
#        src/server.js 3 | test/config.test.js 2
#      `docs` is in NO agent's `writePaths` (frontend apps/web/web/frontend/src; backend
#      apps/server/server/backend/src; database packages/database/database/migrations/src; qa
#      test/tests/__tests__; devops infrastructure/scripts/bin/.github/compose.yaml/Dockerfile/
#      Makefile). So this is the SIXTH instance of the same family (PL-M5/M10/M11/M12/N-18):
#      the plan names a path nobody can write. Expect it to surface once `scripts/` stops being
#      the binding refusal - and treat it as a PREDICTION TO TEST, not a finding:
#        SELECT coalesce(tc.input->>'path', tc.input->>'file_path') AS path, count(*)
#        FROM tool_calls tc JOIN agent_runs ar ON ar.id = tc.agent_run_id
#        WHERE ar.created_at >= '<batch start>'
#          AND tc.tool_name IN ('write_file','edit_file') AND tc.status = 'failed'
#        GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
#   4. PL-M24(1) - the bounded-failure guarantee, re-tested at the NEW value. In L1-M4m run 3
#      seven scoped checks timed out WITH `--test-timeout=100000` and the TAP disappeared
#      entirely. The fix buys "bounded + attributable", not "unfrozen" - a scoped check may
#      still fail, but the TAP must SURVIVE (`# fail 0 / # cancelled N`):
#        SELECT t.task_key, c->>'name', c->>'exitCode', c->>'failureCode',
#               (c->>'command' LIKE '%--test-timeout=20000%') AS new_value,
#               c->>'stdoutTail'
#        FROM tasks t, jsonb_array_elements(t.output->'verification'->'checks') c
#        WHERE t.created_at >= '<batch start>' AND c->>'passed' = 'false'
#          AND c->>'name' = 'test';
#      The closing condition for PL-M24 is: NO scoped check shows the sandbox-killed shape
#      (`exitCode` null / no TAP). `CHECK_TIMEOUT` WITH a surviving TAP is the SUCCESS case here.
#   5. N-20 - the summary must no longer double-count. Recompute from the DB and compare:
#        SELECT t.output->>'errorType' AS task_error_type, count(*)
#        FROM tasks t WHERE t.created_at >= '<batch start>' AND t.status = 'FAILED'
#        GROUP BY 1 ORDER BY 2 DESC;
#      The summary's `errorTypes` must equal THIS table, not twice it. L1-M4m run 2 reported
#      `TIMEOUT: 6` when only 3 tasks had timed out. **Batch attribution is from `tasks` /
#      `agent_runs`, never from the summary** (docs/194).
#   6. THE REPLAN RE-CENSUS (docs/196 sec.8 item 1). "replan does not converge" was REFUTED as a
#      routing defect and re-attributed to N-13; it is now a re-census item. After this batch,
#      re-run the same query - if the chains are STILL non-convergent, that is a NEW, unexplained
#      defect and needs its own entry in the registry:
#        WITH chain AS (
#          SELECT workflow_run_id, task_key, status,
#                 output->'verification'->'checks'->1->>'failureCode' AS fc,
#                 replace(replace(task_key,'-REPLAN-2',''),'-REPLAN-1','') AS base
#          FROM tasks WHERE task_key LIKE '%REPLAN-%')
#        SELECT c2.workflow_run_id, c2.base, c1.status AS s1, c1.fc AS fc1, c2.status AS s2, c2.fc AS fc2
#        FROM chain c2 JOIN chain c1 ON c1.workflow_run_id = c2.workflow_run_id AND c1.base = c2.base
#        WHERE c2.task_key LIKE '%-REPLAN-2' AND c1.task_key LIKE '%-REPLAN-1';
#   7. N-12 (PL-M19) is STILL UNTESTED - L1-M4k, L1-M4l and L1-M4m all produced ZERO `unresolved`
#      rows. Watch again; any chain whose LAST element is SUCCESS in a workflow that still ended
#      FAILED with "Workflow contains unresolved failed tasks" is a regression - stop and report.
#   8. N-6 must stay ABSENT (PL-M17): count of agent_runs with `reasoning_content` in error text.
#   9. N-7 must stay ABSENT: "Recursion limit of 25 reached without hitting a stop condition".
#  10. N-8 must stay ABSENT (PL-M15): the count of `input_tokens > 10M` must not grow (11).
#  11. N-9 must stay ABSENT (PL-M16): zero `agent_action` events with action `tool_call_requested`.
#  12. N-10 must stay ABSENT: `VACUOUS_TEST` / `EVIDENCE_MISSING`.
#  13. scopeViolations should stay 0 (PL-M12) - and see watch item 3.
#  14. EMPTY_FINAL_ANSWER frequency (5 rows in L1-M4h, 1 in L1-M4i, 1 in L1-M4j; mechanism unknown).
#  15. Reaching the delivery slice ui-deploy-docs would be the FIRST real test of PL-M11 / PL-M12.
#  16. THE STILL-OPEN REGISTRY ROW (docs/146 sec.3): the read side did NOT follow the write side -
#      `read_file Dockerfile` is still refused because `readPaths` carries no deliverables. Watch
#      whether it becomes binding this time; if so the fix must be SAME-SOURCE with the write side
#      (one predicate), not a fourth hand-copied list.
#  17. The seven L1-M4k same-batch observations are UNFIXED BY DESIGN (docs/187 sec.7 item 6:
#      register only, fix none). Watch whether any of them becomes the binding constraint:
#      backend-agent write scope vs tests/, `run_unit_test` script-only policy, the dual server
#      entry, `store.mjs` synchronous busy-wait, the AC-06 fixture defect. (The replan-routing one
#      is refuted and folded into watch item 6.)
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4n-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4n-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4n"
mkdir -p "$OUT_DIR"

# Provider week boundary: anchor 2026-10-11 23:00 UTC, 7-day cadence, computed from "now".
# Anchor epoch 1791759600. See the QUOTA NOTE above for why this is computed, not hardcoded.
week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${L1_M4N_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${L1_M4N_GUARD_LIMIT:-400000000}"             # 400M = user-authorised line, 2026-10-18
COOLDOWN_SECS="${L1_M4N_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4N_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4N_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4N_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4N_E1_X3_ALL_COMPLETE"
