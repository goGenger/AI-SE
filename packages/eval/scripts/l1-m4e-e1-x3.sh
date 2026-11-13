#!/usr/bin/env bash
# L1-M4e acceptance batch: the fifth attempt at the E1 full-chain x3 batch for the L1-8 acceptance
# item (docs/154 sec.3 M4), now carrying the PL-M13 (N-6) fixes on top of PL-M7..PL-M12.
#
# Batch history (each attempt is a separate results dir so runs are never mixed across platform
# versions - see docs/164 sec.7 item 4, docs/168 sec.7 item 7, docs/170 sec.7 item 8):
#   results/l1-m4   PL-M4   run 1 only (aborted: slice-outside red test killed the slice's dev task)
#   results/l1-m4b  L1-M4b  run 1 only (aborted: N-2 - the scaffold task could not write the
#                   repository root, so the workflow died on its FIRST task)
#   results/l1-m4c  L1-M4c  runs 1-2 (aborted: run 1 died in planning, run 2 reached the FINAL slice
#                   S4-deploy-ui for the first time - 47 tasks SUCCESS - then died on N-4: no agent
#                   could write the repository-root Dockerfile / README.md)
#   results/l1-m4d  L1-M4d  runs 1-2 (aborted 2026-10-17 06:29 UTC: both runs died on N-6, the
#                   gateway message-shape 400s. NOTE: the stop was INCOMPLETE - the harness was
#                   killed but run 3's server-side workflow kept running until 06:55:47 and burned
#                   7.61M tokens after the stop. Use l1-m4e-stop.sh, which cancels server-side.)
#   results/l1-m4e  this batch (PL-M13: the platform no longer drops additional_kwargs when it
#                   rebuilds an AIMessage, and the tool-content patch normalises non-string
#                   tool message content to a string)
#
# QUOTA NOTE: proxy usage at launch was 120,977,121 / 200,000,000 (window opened 2026-10-11 23:00 UTC,
# refreshes 2026-10-18 23:00 UTC). Measured per-workflow cost in the autonomy-L1 era (2026-10-16..17)
# runs 5M-16M, so three runs land at 15M-48M against 79M of headroom. The guard below re-checks
# before every run and stops at the 200M line.
#
# Contract is otherwise identical to l1-m4d-e1-x3.sh so the staging-segment numbers stay comparable
# with the G baseline and the four earlier attempts.
#
# Watch items for this batch:
#   1. THE HEADLINE: both N-6 400s must be ABSENT. That is the only real test of PL-M13 - the probe
#      proved the mechanism on a fake gateway, never on the real one (docs/173 Known Issues 7).
#      Specifically watch for:
#        "The `reasoning_content` in the thinking mode must be passed back to the API"
#        "tool message content must be a string on the gRPC path"
#      A single recurrence means the fix is incomplete (or there is a second platform-side cause).
#   2. S4-deploy-ui must run to the end. S4-10 (root Dockerfile) and S4-13 (root README.md) are the
#      two tasks PL-M11 unblocked; S4-15 (BUILD) and S4-16..18 (DEPLOY) are what has to reach the
#      staging segment (CI AND staging DEPLOY AND staging VERIFY) for L1-8 to pass at 2/3.
#      PL-M11 and PL-M12 have NEVER been exercised by any batch - l1-m4c run 2 died before the
#      delivery slice, l1-m4d never got past slice 2.
#   3. PLAN_TEST_BEFORE_SCRIPT_PROVIDER / TASK_CHECK_UNAVAILABLE frequency (docs/167 KI 1).
#      l1-m4d run 1 saw 0 of the former and 2 of the latter.
#   4. scopeViolations should stay 0 (PL-M12). A non-zero value means the drift removal did not
#      hold in a live run.
#   5. Read-side denial is still expected (docs/171 KI 1): readPaths were deliberately not widened,
#      so a "Path is not readable: Dockerfile" TOOL_ERROR is not a regression.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4e-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-m4e-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4e"
mkdir -p "$OUT_DIR"

WEEK_START="${L1_M4E_WEEK_START:-2026-10-11 23:00:00+00}"   # weekly window (docs/127)
GUARD_LIMIT="${L1_M4E_GUARD_LIMIT:-200000000}"             # 200M stop-line (user ruling 2026-10-14)
COOLDOWN_SECS="${L1_M4E_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4E_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4E_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4E_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4E_E1_X3_ALL_COMPLETE"
