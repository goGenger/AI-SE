#!/usr/bin/env bash
# L1-rv1: autonomy L1 revalidation (docs/247 / docs/248). E1 x3 + --autonomy-l1.
# Success: staging segment delivered >= 2/3 AND AUTO_APPROVED events on staging DEPLOY runs.
# Run 1 passes --replan so planning is fresh on current platform (gate P1 + Phase 8).
# Does NOT rewrite .env. OpenCode path only.
#
# HARD PRECONDITIONS (assertions, not switches - same shape as f1-frontend-x3.sh):
#   1. capabilityProfile must be backend-node (E1 fixtureTier). frontend-vue disables
#      DATABASE/BACKEND agents -> instant TASK_EXECUTION_ERROR on Scripted/ stale Todo plans.
#   2. model provider must NOT be mock and apiKey must be configured. mock =>
#      ScriptedPlanningModel Todo DAG + zero tokens + empty workspace (docs/129 / docs/248).
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/l1-rv1-e1-x3.sh
# To stop: bash packages/eval/scripts/l1-rv1-stop.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/l1-rv1"
mkdir -p "$OUT_DIR"

week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${L1_RV1_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${L1_RV1_GUARD_LIMIT:-950000000}"
COOLDOWN_SECS="${L1_RV1_COOLDOWN_SECS:-300}"
PORT="${L1_RV1_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
EXPECTED_PROFILE="${L1_RV1_EXPECTED_PROFILE:-backend-node}"
DEADLINE_EPOCH="${L1_RV1_DEADLINE_EPOCH:-0}"

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

  # PRECONDITION 1: E1 must run under backend-node (docs/235 fixtureTier + docs/248).
  profile=$(curl -s --max-time 3 "$BASE_URL/health" | sed -n 's/.*"capabilityProfile":"\([a-z-]*\)".*/\1/p')
  if [ "$profile" != "$EXPECTED_PROFILE" ]; then
    log "FATAL: capability profile is ${profile:-not-exposed}, expected $EXPECTED_PROFILE."
    log "  Start the platform with CAPABILITY_PROFILE=$EXPECTED_PROFILE (docs/235 sec.6.6)."
    log "  frontend-vue + E1 yields instant DATABASE TASK_EXECUTION_ERROR (docs/248)."
    exit 7
  fi
  log "capability profile asserted: $profile"

  # PRECONDITION 2: real model path (docs/129 / docs/248). mock burns the batch in seconds.
  # Parse model-config with python: JSON may have spaces after ':' (sed is brittle).
  eval "$(curl -s --max-time 3 "$BASE_URL/api/model-config" | python3 -c 'import json,sys
d=json.load(sys.stdin).get("data") or {}
print("provider="+str(d.get("provider") or ""))
print("api_key="+("true" if d.get("apiKeyConfigured") else "false"))')"
  if [ -z "$provider" ] || [ "$provider" = "mock" ] || [ "$api_key" != "true" ]; then
    log "FATAL: platform model is provider=${provider:-unknown} apiKeyConfigured=${api_key:-unknown}"
    log "  mock / missing key => ScriptedPlanningModel Todo plan, zero tokens, empty workspace."
    log "  Relaunch after sourcing .env and exporting LLM_PROVIDER=openai (do not rewrite .env)."
    exit 6
  fi
  log "model provider asserted: $provider (apiKeyConfigured=$api_key)"

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
  if [ "$rc" = "42" ]; then log "L1_RV1_DEADLINE_STOP"; exit 0; fi
done
log "L1_RV1_E1_X3_ALL_COMPLETE"
