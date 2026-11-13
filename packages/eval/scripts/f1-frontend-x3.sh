#!/usr/bin/env bash
# F1 x3: the frontend-only fixture (docs/233) under the browser oracle.
#
# WHAT THIS BATCH IS FOR
#   docs/233 sec.6.2 condition 5: four slices, no Node-contract false failures at the per-task
#   gate, and CI -> staging deploy -> staging verify all reachable. Everything else in that
#   condition (reference 20/20 x3, template >=15 Must failures, both mutants) is measured
#   LOCALLY and is already recorded in docs/235 sec.6.4 - it needs no platform and no quota.
#
# HARD PRECONDITIONS (the script refuses to launch until both are closed)
#   1. The platform must be running the `frontend-vue` capability profile. The selection
#      mechanism exists (docs/235 sec.6.6: CAPABILITY_PROFILE env, exposed on /health), but the
#      DEFAULT stays `backend-node` on purpose, so this guard exits 7 unless the operator
#      deliberately restarted with CAPABILITY_PROFILE=frontend-vue. Running it anyway would
#      measure `backend-node` behaviour and label it F1 - a wrong reading, not a cheap one.
#   2. The sandbox image must ship a browser. `ui-smoke` resolves `playwright` from the
#      workspace, but the chromium binary has to be preinstalled (docs/234: Dockerfile.ui with
#      WITH_BROWSER=1). Without it every boundary check reads BROWSER_UNAVAILABLE (recorded,
#      but the gate never fires). Guard exits 8.
#   Both guards are assertions, not switches: no environment variable bypasses them.
#
# WHAT IT MEASURES
#   - chain completion and the staging segment for a FRONTEND-only requirement;
#   - per-task gate failures that are NOT Node-contract shaped (the point of the pivot);
#   - `verificationFailureCodes` for ui-smoke (SURFACE_MISSING / CONSOLE_ERROR / PAGE_UNREACHABLE)
#     - they must be zero on a slice that ships a working page;
#   - falsePositiveRate must stay 0.
#
# POLICY (l1-m4v: first F1 run died here)
#   The script used to run with the frozen P0 policy (RETRY / allowReplan=false). A task whose
#   agent asks for REPLAN then can never be repaired: the request is discarded, the task retries
#   once and the whole workflow FAILS. F1 run 1 (2026-10-27) died exactly that way after 15 min.
#   `--autonomy-l1` sets failureStrategy=REPLAN and allowReplan=true, which is what every recent
#   E1 batch used - F1 must run under the same policy or its readings are not comparable.
#   Readings are NOT comparable with the nine backend fixtures (docs/235 sec.7: different profile,
#   different tier). Report F1 in its own table.
#
# ACCOUNTING (declare before the run)
#   - F1 is a new tier in the report ("F1" row appears for the first time).
#   - `ui-smoke` check name and its three failure codes are new in verification records.
#   - If a slice fails only on `ui-smoke`, that is the gate firing - read the evidence before
#     calling it a regression (docs/233 sec.6.3).
#
# RUNS (default 1, changed 2026-10-28)
#   docs/233 sec.6.2 condition 5 asks for ONE end-to-end batch, not three. The x3 default was
#   copied from the E1 batches, where cross-run stability is the point; an F1 run costs 4h25m
#   (measured, docs/235 sec.6.8), so three runs would be ~13h for a reading one run already gives.
#   F1_RUNS=N still works for a deliberate stability check. A run whose result file exists is
#   skipped, so a later invocation resumes. Only run 1 passes --replan.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/f1-frontend-x3.sh
#   three runs (stability check): F1_RUNS=3 caffeinate -s -d -i bash packages/eval/scripts/f1-frontend-x3.sh
# To stop: bash packages/eval/scripts/f1-frontend-stop.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/f1-frontend"
mkdir -p "$OUT_DIR"

week_start_default() {
  local anchor=1791759600 now weeks
  now=$(date -u +%s)
  weeks=$(( (now - anchor) / 604800 ))
  date -u -r $(( anchor + weeks * 604800 )) '+%F %T+00'
}
WEEK_START="${F1_WEEK_START:-$(week_start_default)}"
GUARD_LIMIT="${F1_GUARD_LIMIT:-1400000000}"
COOLDOWN_SECS="${F1_COOLDOWN_SECS:-300}"
PORT="${F1_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
EXPECTED_GATE="${F1_EXPECTED_GATE:-enforce}"
EXPECTED_PROFILE="${F1_EXPECTED_PROFILE:-frontend-vue}"
DEADLINE_EPOCH="${F1_DEADLINE_EPOCH:-0}"
RUNS="${F1_RUNS:-1}"

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

  gate=$(curl -s --max-time 3 "$BASE_URL/health" | sed -n 's/.*"verificationGate":"\([a-z]*\)".*/\1/p')
  if [ "$gate" != "$EXPECTED_GATE" ]; then
    log "FATAL: verification gate mismatch (runtime=${gate:-unknown} expected=$EXPECTED_GATE), abort"
    exit 5
  fi
  log "verification gate asserted: $gate"

  provider=$(curl -s --max-time 3 "$BASE_URL/api/model-config" | sed -n 's/.*"provider":"\([a-z]*\)".*/\1/p')
  if [ -z "$provider" ] || [ "$provider" = "mock" ]; then
    log "FATAL: platform model provider is ${provider:-unknown} (mock = zero artefacts); source .env, abort"
    exit 6
  fi
  log "model provider asserted: $provider"

  # Round16: the live process can still be on opencode.ai/zen/go while .env already
  # points at DeepSeek. Measuring against a stale provider burns the batch on quota.
  set -a; source "$ROOT/.env"; set +a
  live_base=$(curl -s --max-time 3 "$BASE_URL/api/model-config" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(((d.get("data") or {}).get("baseUrl") or ""))')
  disk_base="${OPENAI_BASE_URL:-}"
  live_host=$(OPENAI_LIVE_BASE="$live_base" python3 -c 'import os; from urllib.parse import urlparse; print(urlparse(os.environ.get("OPENAI_LIVE_BASE","")).hostname or "")')
  disk_host=$(OPENAI_DISK_BASE="$disk_base" python3 -c 'import os; from urllib.parse import urlparse; print(urlparse(os.environ.get("OPENAI_DISK_BASE","")).hostname or "")')
  if [ -n "$live_host" ] && [ -n "$disk_host" ] && [ "$live_host" != "$disk_host" ]; then
    log "FATAL: platform baseUrl host is $live_host but .env OPENAI_BASE_URL host is $disk_host"
    log "  Restart the platform after sourcing .env (stale process was the round16 root cause)."
    exit 9
  fi
  log "model baseUrl host asserted: ${live_host:-unknown}"

  # PRECONDITION 1: the platform must be measuring under the frontend profile.
  profile=$(curl -s --max-time 3 "$BASE_URL/health" | sed -n 's/.*"capabilityProfile":"\([a-z-]*\)".*/\1/p')
  if [ "$profile" != "$EXPECTED_PROFILE" ]; then
    log "FATAL: capability profile is ${profile:-not-exposed}, expected $EXPECTED_PROFILE."
    log "  Start the platform with CAPABILITY_PROFILE=$EXPECTED_PROFILE (docs/235 sec.6.6)."
    log "  Running now would measure backend-node behaviour and label it F1."
    exit 7
  fi
  log "capability profile asserted: $profile"

  # PRECONDITION 2: the sandbox image must ship a browser (docs/234).
  set -a; source "$ROOT/.env"; set +a
  image="${SANDBOX_IMAGE:-ai-se-sandbox:22-pnpm9}"
  env_dump=$(docker image inspect "$image" --format '{{json .Config.Env}}' 2>/dev/null || true)
  if [ -z "$env_dump" ]; then
    log "FATAL: sandbox image '$image' not found (check SANDBOX_IMAGE in .env), abort"
    exit 8
  fi
  case "$env_dump" in
    *PLAYWRIGHT_BROWSERS_PATH*) log "sandbox image carries a browser: $image" ;;
    *)
      log "FATAL: sandbox image '$image' has no PLAYWRIGHT_BROWSERS_PATH."
      log "  ui-smoke would skip every boundary check with BROWSER_UNAVAILABLE (docs/234)."
      exit 8
      ;;
  esac

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
      --fixtures F1 --runs 1 --autonomy-l1 --out "$OUT_DIR/run-$n.json" $EXTRA ) 2>&1
  log "run $n done exit=$?"
}

for n in $(seq 1 "$RUNS"); do
  run_one "$n"
  rc=$?
  if [ "$rc" = "42" ]; then log "F1_DEADLINE_STOP"; exit 0; fi
  if [ "$n" -lt "$RUNS" ]; then sleep "$COOLDOWN_SECS"; fi
done
log "F1_FRONTEND_X3_ALL_COMPLETE runs=$RUNS"
