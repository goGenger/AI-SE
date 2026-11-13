#!/usr/bin/env bash
# L1-M4c acceptance batch: the third attempt at the E1 full-chain x3 batch for the L1-8 acceptance
# item (docs/154 sec.3 M4), now carrying the PL-M10 fix as well as PL-M7 / PL-M8 / PL-M9.
#
# Batch history (each attempt is a separate results dir so runs are never mixed across platform
# versions - see docs/164 sec.7 item 4 and docs/168 sec.7 item 7):
#   results/l1-m4   PL-M4  run 1 only (aborted: slice-outside red test killed the slice's dev task)
#   results/l1-m4b  L1-M4b run 1 only (aborted: N-2 - the scaffold task could not write the
#                   repository root, so the workflow died on its FIRST task)
#   results/l1-m4c  this batch (PL-M10 lets implementation agents write root manifests/configs)
#
# Contract is otherwise identical to l1-m4-e1-x3.sh / l1-m4b-e1-x3.sh so the staging-segment
# numbers stay comparable with the G baseline and with the two aborted runs.
#
# Watch items for this batch:
#   1. PLAN_TEST_BEFORE_SCRIPT_PROVIDER / TASK_CHECK_UNAVAILABLE frequency (docs/167 KI 1) -
#      never observed yet: both earlier runs died before reaching any TEST task. If the first is 0
#      while the second is non-zero, the planner is not declaring providesScripts and 9c has turned
#      the silent hole into a hard stop.
#   2. Root-level SOURCE files (docs/169 KI 1) - the audit allows an implementation task to write a
#      root-level source file (e.g. index.js) but the permission gate still denies it. If the plan
#      puts the service entry point at the repository root instead of src/, the same fatal shape
#      returns.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-m4c-e1-x3.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-m4c"
mkdir -p "$OUT_DIR"

WEEK_START="${L1_M4C_WEEK_START:-2026-10-11 23:00:00+00}"   # OpenCode Go weekly window (docs/127)
GUARD_LIMIT="${L1_M4C_GUARD_LIMIT:-200000000}"             # 200M stop-line (user ruling 2026-10-14)
COOLDOWN_SECS="${L1_M4C_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3 precedent)
PORT="${L1_M4C_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
DEADLINE_EPOCH="${L1_M4C_DEADLINE_EPOCH:-0}"               # optional: no NEW run starts at/after this epoch

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
  if [ "$rc" = "42" ]; then log "L1_M4C_DEADLINE_STOP"; exit 0; fi
done
log "L1_M4C_E1_X3_ALL_COMPLETE"
