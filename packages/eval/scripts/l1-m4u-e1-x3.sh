#!/usr/bin/env bash
# L1-M4u: E1 x3 under autonomy L1. First batch that can actually VERIFY the N-33 prompt fix.
#
# WHAT CHANGED SINCE L1-M4t  (all landed 2026-10-22; platform restarted after the last one)
#   N-33 / PL-M34 (docs/218 + section 12 correction): the final-slice planning prompt now spells
#     out all four delivery blocks. L1-M4t could NOT test it: a batch shares ONE plan generated at
#     run 1 (harness.ts:122-128), and run 1 planned before the fix. Run 3's T18 was literally the
#     same database row as run 1's. THIS batch plans fresh because run 1 passes --replan, so the
#     new prompt is read for the first time. A read-only planning probe (PL-M37, docs/221) already
#     reported VERIFY-PRESENT on this batch's exact inputs.
#   N-34 / PL-M35 (docs/219): scoped test commands now SELECT FILES (node -e probe + explicit paths)
#     instead of only filtering test names. Verified in the real DockerSandbox e2e.
#   N-27 / PL-M36 (docs/220): a command-filtered test check with ZERO scoped AC results is now a
#     failure instead of a vacuous pass (node --test exits 0 when the pattern matches nothing).
#   N-35 / PL-M38 (docs/222): the slice-boundary check is no longer skipped whenever a sibling task
#     row is FAILED-but-resolved by a replan (86% of failing workflows had no boundary check).
#   N-1b / PL-M39 (docs/223): DATABASE tasks with NO migration scripts fall back to build+test
#     instead of having zero objective checks (22 instances / 21 runs, one per E1 final slice).
#
# WHAT THIS BATCH PROVES
#   35a  Final slice plans a task with delivery.action="VERIFY" (type TEST), i.e. the prompt fix
#        survives a real planning run (the probe only proved the planning step in isolation).
#   35b  That task is executed by `delivery-orchestrator` (agent_runs.input.runtime), not a
#        professional agent. This is N-31's criterion, never yet observed in a real batch.
#   35c  collectStagingSegment `verify` is no longer null => the staging segment becomes judgeable.
#   35d  Scoped test commands carry explicit file lists; 35e attempts drop from ~120s to seconds;
#   35f  CHECK_TIMEOUT count falls well below M4t's run 1 = 11 / run 2 = 6.
#   36a  A test check with exitCode=0 but no scoped AC results is recorded as FAILED and carries
#        uncoveredAcKeys (the shape the old code passed).
#   36d  falsePositiveRate stays 0.
#   38a  A slice that had a replan now gets a slice-boundary check.
#   38b  Boundary coverage over workflows with any FAILED task rises above the 24/169 baseline.
#   38c  falsePositiveRate stays 0 (the boundary is a real test run, not a relaxed rule).
#   39a  verificationUnavailable for E1 is 0 (it was exactly 1 DATABASE per run in M4t).
#   39b  DATABASE task records now carry build/test checks instead of an empty list.
#
# ACCOUNTING CHANGES (declared before the run - do not read as regressions)
#   - verificationUnavailable SHOULD go 1 -> 0 (N-1b). A drop is the fix working.
#   - task-level verification divergence MAY rise: DATABASE tasks are now really judged and the
#     boundary check runs more often. In observe mode nothing blocks; the change is in accounting.
#   - The staging segment MAY finally be non-null. Only then is L1-8's 2/3 criterion meaningful.
#   - falsePositiveRate must stay 0. Any rise means a check got weaker, not stronger.
#
# PLAN REGENERATION PRECONDITION
#   run 1 passes --replan => POST /analyze {regenerate:true} => planning version increments =>
#   slice task plans are regenerated and the new prompt is read. VERIFY AFTER THE BATCH:
#     select slice_key, planning_version, created_at from requirement_slices
#       where requirement_id = (select requirement_id from workflow_runs order by created_at desc limit 1);
#   planning_version MUST differ from M4t's 110/111/112. If it does not, the batch proves nothing
#   about N-33 (see docs/218 section 12).
#
# BUILD PRECONDITION (verified before launch)
#   packages/workflow-engine dist rebuilt AND the platform restarted afterwards (pid 2556,
#   started 21:16 CST). packages/eval runs from src via tsx, so its changes need no rebuild.
#
# QUOTA
#   The weekly guard is RAISED for this batch at the user's instruction (2026-10-22
#   "raise the guard and run the next batch"). M4t finished the window at roughly 741M; a batch
#   costs about 143M input tokens. 950M leaves headroom for all three runs. If the upstream account
#   itself refuses, runs will fail with 429 - that is a real stop, not a guard stop.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4u-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4u-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4u"
mkdir -p "$OUT_DIR"

week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${L1_M4U_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${L1_M4U_GUARD_LIMIT:-950000000}"
COOLDOWN_SECS="${L1_M4U_COOLDOWN_SECS:-300}"
PORT="${L1_M4U_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4U_DEADLINE_EPOCH:-0}"

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
  if [ "$rc" = "42" ]; then log "L1_M4U_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4U_E1_X3_ALL_COMPLETE"
