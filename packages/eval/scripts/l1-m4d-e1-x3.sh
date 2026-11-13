#!/usr/bin/env bash
# L1-M4d acceptance batch: the fourth attempt at the E1 full-chain x3 batch for the L1-8 acceptance
# item (docs/154 sec.3 M4), now carrying the PL-M11 / PL-M12 fixes (root delivery artifacts +
# audit path-table drift) on top of PL-M7 / PL-M8 / PL-M9 / PL-M10.
#
# Batch history (each attempt is a separate results dir so runs are never mixed across platform
# versions - see docs/164 sec.7 item 4, docs/168 sec.7 item 7, docs/170 sec.7 item 8):
#   results/l1-m4   PL-M4   run 1 only (aborted: slice-outside red test killed the slice's dev task)
#   results/l1-m4b  L1-M4b  run 1 only (aborted: N-2 - the scaffold task could not write the
#                   repository root, so the workflow died on its FIRST task)
#   results/l1-m4c  L1-M4c  runs 1-2 (aborted: run 1 died in planning, run 2 reached the FINAL slice
#                   S4-deploy-ui for the first time - 47 tasks SUCCESS - then died on N-4: no agent
#                   could write the repository-root Dockerfile / README.md)
#   results/l1-m4d  this batch (PL-M11 lets implementation/build agents write root delivery
#                   artifacts; PL-M12 removes the audit's false positives)
#
# QUOTA NOTE (deviation from the one-E1x3-batch-per-week default, docs/127 sec.8): the user
# explicitly authorized a second batch inside the same weekly window on 2026-10-17. Proxy usage at
# launch was 86,595,149 / 200,000,000; three runs at the observed ~32M each land near 183M, still
# under the 200M stop-line, and the guard below re-checks before every run.
#
# Contract is otherwise identical to l1-m4c-e1-x3.sh so the staging-segment numbers stay comparable
# with the G baseline and with the three earlier attempts.
#
# Watch items for this batch:
#   1. S4-deploy-ui must now run to the end. S4-10 (root Dockerfile) and S4-13 (root README.md) are
#      the two tasks PL-M11 unblocked; S4-15 (BUILD) and S4-16..18 (DEPLOY) are what has to reach
#      the staging segment (CI AND staging DEPLOY AND staging VERIFY) for L1-8 to pass at 2/3.
#   2. PLAN_TEST_BEFORE_SCRIPT_PROVIDER / TASK_CHECK_UNAVAILABLE frequency (docs/167 KI 1). Run 2
#      of l1-m4c saw 0 of the former and 1 of the latter; if the first stays 0 while the second
#      rises, the planner is still not declaring providesScripts.
#   3. scopeViolations should now be 0. l1-m4c run 2 recorded one false positive ({"violations":
#      ["apps/"]}); PL-M12 removed the drift that produced it. A non-zero value here means the
#      convergence did not hold in a live run.
#   4. Read-side denial is still expected (docs/171 KI 1): readPaths were deliberately not widened,
#      so a "Path is not readable: Dockerfile" TOOL_ERROR is not a regression.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4d-e1-x3.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4d"
mkdir -p "$OUT_DIR"

WEEK_START="${L1_M4D_WEEK_START:-2026-10-11 23:00:00+00}"   # weekly window (docs/127)
GUARD_LIMIT="${L1_M4D_GUARD_LIMIT:-200000000}"             # 200M stop-line (user ruling 2026-10-14)
COOLDOWN_SECS="${L1_M4D_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4D_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4D_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4D_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4D_E1_X3_ALL_COMPLETE"
