#!/usr/bin/env bash
# Eval batch watchdog -- turns a long unattended batch into NOTIFICATIONS.
#
# Why this exists: the per-batch watchdogs added in phases E/F (e1-watchdog.sh, f-l3-watchdog.sh,
# ...) only appended to a log file. Nobody reads a log file, so a finished run was noticed only
# when a human asked "how far did it get". This script is meant to be launched as a
# HARNESS-TRACKED background process (Claude Code Bash tool with run_in_background): it EXITS on
# the first meaningful event, and that exit is what delivers the notification. Re-arm after each
# exit. Its exit code names the event and its stdout carries the status block.
#
# Events (exit code):
#   10  the batch process is gone (batch finished, or it died early)
#   11  a run's result JSON appeared (one run of the batch finished)
#   12  stalled: the eval CLI is alive but nothing moved for --stall-min minutes
#   13  platform unhealthy (GET /health != 200) while the batch is alive
#    0  heartbeat: --heartbeat-min elapsed with no event (progress report only)
#
# Stateless: every invocation re-derives the state, so any session can simply re-arm it.
#
# Usage:
#   bash packages/eval/scripts/eval-batch-watchdog.sh \
#     --batch-pattern l1-m4-e1-x3.sh --results-dir packages/eval/results/l1-m4
#   bash packages/eval/scripts/eval-batch-watchdog.sh --batch-pattern <pat> --once
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.
# NOTE: the file-age scan uses BSD `stat -f %m` (macOS).

set -u
cd "$(dirname "$0")/../../.."
ROOT="$PWD"

RESULTS_DIR="$ROOT/packages/eval/results/l1-m4"
BATCH_PATTERN=""
CLI_PATTERN="src/cli.ts --fixtures"
WORKSPACE_ROOT="$HOME/Desktop/study/ai-se-eval"
LOG="${TMPDIR:-/tmp}/eval-batch-watchdog.log"
HEARTBEAT_MIN=10
STALL_MIN=15
POLL_SEC=30
MAX_HOURS=12
PORT="${EVAL_WATCH_PORT:-47558}"
ONCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --results-dir) RESULTS_DIR="$2"; shift 2 ;;
    --batch-pattern) BATCH_PATTERN="$2"; shift 2 ;;
    --cli-pattern) CLI_PATTERN="$2"; shift 2 ;;
    --workspace-root) WORKSPACE_ROOT="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    --heartbeat-min) HEARTBEAT_MIN="$2"; shift 2 ;;
    --stall-min) STALL_MIN="$2"; shift 2 ;;
    --poll-sec) POLL_SEC="$2"; shift 2 ;;
    --max-hours) MAX_HOURS="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The batch pattern is REQUIRED. Deriving it from the results dir is unsafe: for the L1-M4 batch
# the dir is results/l1-m4 while the batch script is l1-m4-e1-x3.sh, and the sibling launcher
# l1-m4-server-launch.sh stays alive for the whole batch - a too-loose pattern would match the
# launcher and the watchdog would never observe the batch's death.
if [ -z "$BATCH_PATTERN" ]; then
  echo "error: --batch-pattern is required (pgrep -f pattern of the batch script, e.g. l1-m4-e1-x3.sh)" >&2
  exit 2
fi

BASE_URL="http://127.0.0.1:$PORT"
START_EPOCH=$(date +%s)
START_RESULTS=""

note() { printf '%s\n' "[$(date '+%F %T %Z')] $*" >> "$LOG"; }

# Exit code of `pgrep -f "$1"`; also echoes the first pid.
alive_pid() {
  pgrep -f "$1" 2>/dev/null | head -1
}

# Newest mtime (epoch seconds) under a tree, node_modules/.git pruned. 0 when nothing is found.
newest_epoch() {
  local dir="$1" value
  [ -d "$dir" ] || { echo 0; return; }
  value=$(find "$dir" -type d \( -name node_modules -o -name .git \) -prune -o \
            -type f -print0 2>/dev/null | xargs -0 stat -f %m 2>/dev/null | sort -n | tail -1)
  echo "${value:-0}"
}

# Result JSONs present, as "name(mtime)" pairs. Only the batch's own run-N.json counts: archived
# copies (run-1.pre-fix-<stamp>.json and friends) are history, not progress.
result_files() {
  local f b out=""
  for f in "$RESULTS_DIR"/*.json; do
    [ -f "$f" ] || continue
    b=$(basename "$f")
    printf '%s\n' "$b" | grep -Eq '^run-[0-9]+\.json$' || continue
    out="$out $b($(date -r "$f" '+%H:%M'))"
  done
  echo "${out:- none}"
}

# Best-effort platform state from the dev DB. Empty when psql/docker is unavailable.
db_status() {
  [ -f "$ROOT/.env" ] || return 0
  set -a; . "$ROOT/.env"; set +a
  docker exec -i ai-se-postgres-1 psql -U "${POSTGRES_USER:-aise}" -d "${POSTGRES_DB:-aise}" \
    -t -A -F'|' -c "
      SELECT w.id, w.status,
             coalesce((SELECT string_agg(x, ' ') FROM (
               SELECT t.slice_key || ' ok=' || count(*) FILTER (WHERE t.status='SUCCESS')
                      || ' bad=' || count(*) FILTER (WHERE t.status='FAILED')
                      || ' run=' || count(*) FILTER (WHERE t.status='RUNNING')
                      || ' pend=' || count(*) FILTER (WHERE t.status='PENDING')
                      || '/' || count(*) AS x
               FROM tasks t WHERE t.workflow_run_id = w.id GROUP BY t.slice_key ORDER BY t.slice_key
             ) s), 'no tasks')
      FROM workflow_runs w ORDER BY w.created_at DESC LIMIT 1;
    " 2>/dev/null
}

health_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE_URL/health" 2>/dev/null || echo "000"
}

status_block() {
  local event="$1" batch_pid cli_pid health progress now age db
  now=$(date +%s)
  batch_pid=$(alive_pid "$BATCH_PATTERN")
  cli_pid=$(alive_pid "$CLI_PATTERN")
  health=$(health_code)
  progress=$(( $(newest_epoch "$RESULTS_DIR") ))
  local ws; ws=$(newest_epoch "$WORKSPACE_ROOT")
  [ "$ws" -gt "$progress" ] && progress="$ws"
  age=$(( now - progress )); [ "$progress" -eq 0 ] && age=-1
  db=$(db_status)

  echo "=== EVAL BATCH WATCHDOG $(date '+%F %T %Z') ==="
  echo "event     : $event"
  echo "batch     : ${batch_pid:-GONE} (pattern $BATCH_PATTERN)"
  echo "eval cli  : ${cli_pid:-GONE} (pattern $CLI_PATTERN)"
  echo "platform  : $BASE_URL health=$health"
  echo "results   :$(result_files)"
  if [ "$age" -lt 0 ]; then echo "progress  : no files found"; else echo "progress  : last write ${age}s ago"; fi
  if [ -n "$db" ]; then echo "workflow  : $db"; fi
  echo "elapsed   : $(( (now - START_EPOCH) / 60 )) min   log: $LOG"
  echo "==="
}

# --- one-shot mode -----------------------------------------------------------------------------
if [ "$ONCE" -eq 1 ]; then
  status_block "once" | tee -a "$LOG"
  exit 0
fi

# --- arming guard: do not watch a batch that is not running -------------------------------------
if [ -z "$(alive_pid "$BATCH_PATTERN")" ]; then
  status_block "batch is not running - nothing to watch (not armed)" | tee -a "$LOG"
  exit 10
fi

START_RESULTS=$(result_files)
note "watchdog armed: batch=$BATCH_PATTERN results=$(basename "$RESULTS_DIR") start=$START_RESULTS"
note "watchdog armed: heartbeat=${HEARTBEAT_MIN}m stall=${STALL_MIN}m poll=${POLL_SEC}s max=${MAX_HOURS}h"

LAST_HEARTBEAT=$START_EPOCH
# Activity baseline for the stall check. Starts at ARM TIME, not at the newest file's mtime: a
# re-run writes into the SAME workspace path (E1/run-1), so the newest file under --workspace-root
# can be a previous batch's output - the absolute-age test then reports a stall the instant the
# watchdog is armed. See the stall branch below, which also resets the baseline whenever a NEW eval
# CLI process appears (the batch sleeps between runs).
LAST_ACTIVITY=$START_EPOCH
LAST_CLI_PID=""
DEADLINE=$(( START_EPOCH + MAX_HOURS * 3600 ))

while :; do
  sleep "$POLL_SEC"
  now=$(date +%s)

  if [ "$now" -ge "$DEADLINE" ]; then
    status_block "max-hours ($MAX_HOURS h) reached" | tee -a "$LOG"; exit 0
  fi

  batch_pid=$(alive_pid "$BATCH_PATTERN")
  if [ -z "$batch_pid" ]; then
    status_block "batch process gone" | tee -a "$LOG"; exit 10
  fi

  current=$(result_files)
  if [ "$current" != "$START_RESULTS" ]; then
    status_block "new run result: $START_RESULTS ->$current" | tee -a "$LOG"; exit 11
  fi

  health=$(health_code)
  if [ "$health" != "200" ]; then
    status_block "platform unhealthy (health=$health) while batch is alive" | tee -a "$LOG"; exit 13
  fi

  # Stall: the eval CLI is alive (a run is in flight) but nothing has been written for STALL_MIN.
  cli_pid=$(alive_pid "$CLI_PATTERN")
  if [ -n "$cli_pid" ]; then
    # A NEW run process resets the baseline. The batch sleeps COOLDOWN_SECS between runs, so a
    # watchdog armed during that gap carries a baseline from before the cooldown - without this
    # reset it reports a stall the moment the next run's CLI appears (observed 2026-10-17: fired
    # 14 s after run 2 started, "no file writes for 28 min while a run is in flight").
    if [ "$cli_pid" != "$LAST_CLI_PID" ]; then
      LAST_CLI_PID=$cli_pid
      LAST_ACTIVITY=$now
    fi
    progress=$(newest_epoch "$RESULTS_DIR")
    ws=$(newest_epoch "$WORKSPACE_ROOT")
    [ "$ws" -gt "$progress" ] && progress="$ws"
    [ "$progress" -gt "$LAST_ACTIVITY" ] && LAST_ACTIVITY=$progress
    if [ $(( now - LAST_ACTIVITY )) -ge $(( STALL_MIN * 60 )) ]; then
      status_block "stalled: no file writes for $(( (now - LAST_ACTIVITY) / 60 )) min while a run is in flight" \
        | tee -a "$LOG"; exit 12
    fi
  fi

  if [ $(( now - LAST_HEARTBEAT )) -ge $(( HEARTBEAT_MIN * 60 )) ]; then
    status_block "heartbeat (${HEARTBEAT_MIN} min elapsed, no event)" | tee -a "$LOG"; exit 0
  fi
done
