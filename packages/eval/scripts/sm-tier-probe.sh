#!/usr/bin/env bash
# SM-tier probe (2026-10-17): can a CHEAP fixture tier reproduce the agent-layer defects that
# only E1 has produced so far (N-6 gateway message shapes / N-7 recursion limit / N-8 usage guard)?
#
# WHY THIS EXISTS: six E1 x3 acceptance batches have each cost about a day and ~25M input tokens
# and yielded ONE defect at a time, usually on the FIRST task. If a cheap tier drives the agent
# just as deep, defect discovery gets two orders of magnitude cheaper. This is a DIAGNOSTIC run,
# NOT an acceptance batch: it does not touch the L1-8 verdict, and it changes no fixture, oracle
# or EvalPolicy. Policy mirrors l1-m4f (--autonomy-l1, fresh plan) so the numbers are comparable
# with the batch that produced N-6/N-7/N-8.
#
# OFFLINE EVIDENCE BEFORE THIS RUN (2026-10-17, dev DB + code):
#   - The S/M/L tiers were last run 2026-10-07 (results/e2, results/e2b: 47 fixture runs, 222
#     agent runs). They have NEVER run on the current agent (PL-M5..PL-M14).
#   - N-8's precondition is state.iteration >= maxIterations (50). S/M/L topped out at 38
#     (>=50: 0 of 222) while E1 reached 89 (>=50: 18 of 236). So N-8 is NOT expected here.
#   - N-7's precondition (outer graph supersteps > 25) CANNOT be measured from the DB:
#     tool_calls.iteration is written by BOTH the outer tools node (state.iteration) and
#     ToolRuntimeBackend's own inner counter (ToolRuntimeBackend.ts:148/375), so the stored
#     number conflates the two layers. This run is the only way to answer it.
#   - N-6 DID reproduce on S/M/L on 2026-10-07 (2 x "reasoning_content" 400s).
#
# WATCH ITEMS (measure these after the run; all read from agent_runs):
#   1. current_iteration distribution per agent run - did anything reach 50?
#   2. error->>'code' = TOOL_ERROR with message 'Agent reached max iterations'   (N-8 path)
#   3. error->>'message' LIKE '%Recursion limit%'                                (N-7)
#   4. error->>'message' LIKE '%reasoning_content%' / '%tool message content%'   (N-6)
#   5. any (token_usage->>'input_tokens')::bigint > 10000000                     (N-8 bad value)
#
# QUOTA NOTE / CONTROLLED DEVIATION: the weekly guard proxy reads agent_runs.token_usage, and that
# table holds N-8 bad values (four from l1-m4f at ~5.8e18, and - as this probe itself proved on its
# FIRST run - three more from S1). Any plain SUM over that column is therefore meaningless, and a
# stop-line frozen at launch gets tripped by values the probe never really spent: S1's three runs
# moved the raw reading from 5,825,744,767,706,221,469 to 6,308,456,760,578,952,099 while the run
# lasted 4.5 minutes.
#
# So the guard here measures what it was always meant to measure - THIS probe's own spend - by
# summing only rows below a sanity bound (SANE_MAX), and comparing against the same bounded reading
# taken at launch. That is the "reasonableness upper bound" of the N-8 task book (docs/176 sec.4
# ruling 4) applied to the probe script ONLY; the platform-side guard form is still an open
# ruling item under PL-M15.
# No historical row is edited (AGENTS.md sec.6). The bounded reading is re-checked before each run.
#
# Usage: caffeinate -s -d -i bash packages/eval/scripts/sm-tier-probe.sh
# To stop: bash packages/eval/scripts/sm-tier-probe-stop.sh   (kills roles AND cancels server-side)
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
OUT_DIR="$ROOT/packages/eval/results/sm-tier-probe"
mkdir -p "$OUT_DIR"

WEEK_START="${SM_PROBE_WEEK_START:-2026-10-11 23:00:00+00}"  # weekly window (docs/127)
BUDGET="${SM_PROBE_BUDGET:-40000000}"                        # 40M for the whole probe (~200x expected)
SANE_MAX="${SM_PROBE_SANE_MAX:-10000000}"                    # rows above this are N-8 bad values
COOLDOWN_SECS="${SM_PROBE_COOLDOWN_SECS:-1800}"              # 30 min between runs (E-1/F-L4/G-M3)
PORT="${SM_PROBE_PORT:-47558}"
BASE_URL="http://127.0.0.1:$PORT"
TSX="$ROOT/node_modules/.bin/tsx"
FIXTURES="${SM_PROBE_FIXTURES:-S1 M1}"

log() { echo "[$(date '+%F %T %Z')] $*"; }

. "$ROOT/packages/eval/scripts/lib/usage-guard.sh"

BASELINE=$(week_tokens)
case "$BASELINE" in
  ''|*[!0-9]*) log "FATAL: cannot read weekly usage ($BASELINE), abort"; exit 3 ;;
esac
log "sane weekly baseline=$BASELINE (rows >= $SANE_MAX excluded as N-8 bad values); budget=$BUDGET"

# Each fixture is its own run 1, so each gets a fresh plan - the e2b convention, and the only way
# both fixtures are treated identically. The [eval] S1 / [eval] M1 projects already exist (created
# 2026-10-07 / 2026-09-30) and the harness REUSES a project by name (harness.ts:487-495), so
# without --replan a ten-day-old plan would be replayed.
n=0
for fixture in $FIXTURES; do
  n=$(( n + 1 ))
  out="$OUT_DIR/run-$n.json"
  if [ -f "$out" ]; then log "$fixture (run $n) result exists, skip"; continue; fi

  health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE_URL/health" || true)
  if [ "$health" != "200" ]; then log "FATAL: platform unhealthy (health=$health), abort"; exit 4; fi

  used=$(week_tokens)
  case "$used" in
    ''|*[!0-9]*) log "BUDGET-GUARD: cannot read weekly usage ($used), abort"; exit 3 ;;
  esac
  spent=$(( used - BASELINE ))
  log "before $fixture (run $n): sane used=$used baseline=$BASELINE probe-spent=$spent budget=$BUDGET"
  if [ "$spent" -ge "$BUDGET" ]; then log "BUDGET-GUARD: probe spent $spent >= $BUDGET, stop"; exit 2; fi

  log "$fixture (run $n) start (autonomy-l1 --replan)"
  ( cd "$ROOT/packages/eval" && EVAL_BASE_URL="$BASE_URL" "$TSX" src/cli.ts \
      --fixtures "$fixture" --runs 1 --autonomy-l1 --replan --out "$out" ) 2>&1
  log "$fixture (run $n) done exit=$?"

  if [ "$n" -lt 2 ]; then sleep "$COOLDOWN_SECS"; fi
done
log "SM_TIER_PROBE_ALL_COMPLETE"
