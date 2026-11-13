#!/usr/bin/env bash
# L1-M4t batch clean-stop: kills ALL batch process roles (bracket patterns avoid pgrep self-match)
#
# WHY THIS EXISTS: during l1-m4d the stop killed only the harness. The workflow had already been
# created server-side, so it kept running for 27 minutes and burned 7.61M tokens with nobody
# watching (memory: stop-batch-cancels-workflow). Killing the harness is NOT a stop - the
# server-side workflow has to be cancelled too.
#
# NOTE: the "[l]1-m4t" pattern also matches this batch's watchdog command line (it carries the
# batch pattern as an argument), so this stop kills the watchdog too. Intended at stop time.
# NOTE: patterns are scoped to THIS batch only.
#
# Usage: bash packages/eval/scripts/l1-m4t-stop.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
PORT="${L1_M4T_PORT:-47558}"

echo "stopping l1-m4t batch roles..."
for pat in "[l]1-m4t-e1-x3.sh" "[l]1-m4t" "[s]rc/cli.ts --fixtures E1" "[c]affeinate -s -d -i"; do
  pkill -f "$pat" 2>/dev/null && echo "killed: $pat"
done
pkill -f "[s]leep 1800" 2>/dev/null && echo "killed: stray sleep 1800"
sleep 2
echo "--- remaining ---"
pgrep -fl "[l]1-m4t" | head -5
pgrep -fl "[s]rc/cli.ts" | head -4
echo "(empty above = clean)"

echo "cancelling running workflows on :$PORT..."
set -a; source "$ROOT/.env"; set +a
IDS=$(docker exec ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c \
  "select id from workflow_runs where status in ('RUNNING','PENDING','WAITING_APPROVAL');")
if [ -z "$IDS" ]; then
  echo "none running"
else
  for id in $IDS; do
    code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/workflows/$id/cancel" || true)
    echo "cancelled $id (http=$code)"
  done
fi

echo "--- verifying no RUNNING/PENDING/WAITING_APPROVAL remain ---"
docker exec ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select id, status, updated_at from workflow_runs where status in ('RUNNING','PENDING','WAITING_APPROVAL');"
echo "done"
