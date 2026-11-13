#!/usr/bin/env bash
# L1-M4v: E1 x3 under autonomy L1. Second batch after L1-8 was reached (L1-M4u).
#
# WHAT CHANGED SINCE L1-M4u
#   Boundary observation (docs/224 sec.9 item 2): `maybeSliceBoundaryCheck` now returns a reason
#     code on each of its six early exits, persisted as `output.verification.boundarySkipped`.
#     OBSERVATION ONLY - no decision path changed. It exists to answer why two of the ten
#     slices with a failed task in M4u got no boundary check: replaying the predicate over the
#     FINAL database state said all 14/16 anchors WOULD run, so the miss is in the runtime state
#     at verification time, and we need a reading instead of a hypothesis.
#   N-36 (docs/224 sec.2.1): `collectStagingSegment` now takes the LAST attempt of each stage
#     instead of the first match. In M4u run 2 the CI failed, was replanned, and the retry passed
#     on the same commit before deploy; the metric read the original FAILED row and scored the
#     staging segment 0. The runs below are measured with the fixed rule.
#
# WHAT THIS BATCH PROVES
#   40a  The boundarySkipped distribution explains every slice that got no boundary check.
#        Query: select output->'verification'->>'boundarySkipped', count(*) from tasks
#               where workflow_run_id in (...) group by 1;
#        NULL + no slice-boundary check would mean a seventh exit path exists.
#   40b  Slices whose replan chain ends the slice now get a boundary check (the M4u misses).
#   41a  L1-8 REPRODUCES: staging segment >= 2/3 for a second consecutive batch, with the
#        N-36 rule in effect (so a repaired CI counts once it passed before deploy).
#   41b  No run relies on the M4u metric bug: if a run repeats the fail-replan-pass CI shape,
#        staging must still read SUCCESS.
#   Re-verified: 35a/35b/35c (VERIFY planned + orchestrator runtime), 35d-35f (no CHECK_TIMEOUT),
#        36a (zero-evidence test check fails), 38a/38b (boundary coverage), 39a (undecidable = 0).
#
# N-25 / PL-M41 (docs/225): planning usage is now collected at all. The weekly guard sums
#   `agent_runs.token_usage`, and planning runs used to contribute ZERO to it (807 runs, all
#   empty). From this batch on, every planning stage reports usage, so the guard FINALLY SEES
#   that spend. Consequence: the weekly reading will jump by roughly the planning cost of this
#   batch. That is not a regression -- it is the guard closing a blind spot (docs/206 sec.4 28e).
#   The guard limit is raised to 1400M for this batch to leave room for the newly visible spend.
#
# ACCOUNTING CHANGES (declared before the run)
#   - `boundarySkipped` appears in verification records for the first time. It is additive and
#     must not change any verdict.
#   - The staging segment is now measured with the N-36 rule. If any run repairs a CI failure,
#     that run's staging may read SUCCESS where the old rule would have read FAILED. This is the
#     declared rule change, not a change in what the platform did.
#   - falsePositiveRate must stay 0.
#
# PLAN REGENERATION PRECONDITION
#   run 1 passes --replan => the requirement is re-analysed and the four slice task plans are
#   regenerated with the current prompt. The M4u plan was 114/115/116/117; VERIFY AFTER THE BATCH
#   that the slice task rows are newer than this batch's start.
#
# BUILD PRECONDITION (verified before launch)
#   Platform restarted at pid 89518 (23 Oct 2026 12:10:09 local) AFTER the N-25 / PL-M41 rebuild
#   of @ai-se/agent-core dist (09:37) AND the autonomy-L2 rebuild (12:05), so planning usage
#   recording is live. @ai-se/agent-core resolves through package.json "main": dist/index.js, so
#   the start time MUST postdate the build - an earlier restart loads stale code and 28a silently
#   fails. The L2 changes are additive and the default path is identical: requirements created
#   without `autonomyLevel` keep the gate-1 behaviour of this batch unchanged.
#   `packages/eval` runs from src via tsx, so the N-36 change needs no rebuild.
#
# QUOTA
#   Launch is manual, at a time the user picks (evening). Weekly usage at hand-off is
#   975,899,515 of the weekly window that resets 2026-10-25 23:00 UTC. L1-M4u spent 235.0M
#   across three runs (85.1M / 82.9M / 67.0M). N-25 makes the planning stage visible to the
#   guard for the first time (see below), so the same batch will now read higher; the guard is
#   set to 1400M to leave about 424M of headroom for that newly visible spend.
#   RE-CHECK the weekly reading immediately before launching: if the window has rolled over,
#   the guard leaves far more room than needed, and if it has not, 424M still covers ~235M of
#   agent spend plus the planning delta. If the upstream account refuses, runs fail with 429 -
#   that is a real stop, not a guard stop.
#
# SPLIT MODE (run-level)
#   L1_M4V_RUNS=N runs only the first N runs. The loop already skips a run whose result file
#   exists, so split mode is resumable at run granularity: `L1_M4V_RUNS=1` now, then any later
#   invocation with the default 3 continues at run 2. Only run 1 passes --replan, so the session
#   that starts run 1 is the one that regenerates the plan; a later resume must not re-pass it.
#   Coverage cost of split mode: the batch is unchanged, only its calendar is - 41a ("staging
#   segment >= 2/3 for a SECOND consecutive batch") can only be read once all three runs exist.
#   Measured per-run wall time (l1-m4u): 133.9 / 136.3 / 168.7 min.
#   Measured per-slice wall time: foundation 23-29, auth 44-65, tasks-core 34-51,
#   crud-isolation 23-27 min. Slices are NOT independently runnable: each run builds one
#   workspace and slice N+1 compiles on slice N's code (cli.ts prepareWorkspace), so "four
#   batches by slice" would need a new resumable runner, not this script.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4v-e1-x3.sh
#   one run only: L1_M4V_RUNS=1 caffeinate -s -d -i bash packages/eval/scripts/l1-m4v-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4v-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4v"
mkdir -p "$OUT_DIR"

week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${L1_M4V_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${L1_M4V_GUARD_LIMIT:-1400000000}"
COOLDOWN_SECS="${L1_M4V_COOLDOWN_SECS:-300}"
PORT="${L1_M4V_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
# N-39: the gate this batch is measured under. Override only when the platform was
# deliberately started with a different VERIFICATION_GATE.
EXPECTED_GATE="${L1_M4V_EXPECTED_GATE:-enforce}"
DEADLINE_EPOCH="${L1_M4V_DEADLINE_EPOCH:-0}"
RUNS="${L1_M4V_RUNS:-3}"

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

  # N-39: assert the RUNTIME verification gate before spending quota. The gate used to
  # depend only on how the platform was launched, so two batches could look identical
  # while being measured under different rules.
  gate=$(curl -s --max-time 3 "$BASE_URL/health" | sed -n 's/.*"verificationGate":"\([a-z]*\)".*/\1/p')
  if [ "$gate" != "$EXPECTED_GATE" ]; then
    log "FATAL: verification gate mismatch (runtime=${gate:-unknown} expected=$EXPECTED_GATE), abort"
    exit 5
  fi
  log "verification gate asserted: $gate"

  # N-42: assert the platform is NOT on the mock model. A mock instance ("success" with zero
  # artifacts) produces readings that mean nothing, and it is invisible unless you ask.
  provider=$(curl -s --max-time 3 "$BASE_URL/api/model-config" | sed -n 's/.*"provider":"\([a-z]*\)".*/\1/p')
  if [ -z "$provider" ] || [ "$provider" = "mock" ]; then
    log "FATAL: platform model provider is ${provider:-unknown} (mock = zero artefacts); source .env, abort"
    exit 6
  fi
  log "model provider asserted: $provider"

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
}

for n in $(seq 1 "$RUNS"); do
  run_one "$n"
  rc=$?
  if [ "$rc" = "42" ]; then log "L1_M4V_DEADLINE_STOP"; exit 0; fi
  if [ "$n" -lt "$RUNS" ]; then sleep "$COOLDOWN_SECS"; fi
done
log "L1_M4V_E1_X3_ALL_COMPLETE runs=$RUNS"
