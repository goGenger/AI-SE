#!/usr/bin/env bash
# SM-tier probe clean-stop: kills ALL probe process roles (bracket patterns avoid pgrep self-match)
# and cancels any RUNNING/PENDING workflow on the dedicated :47558 instance.
#
# WHY THE CANCEL MATTERS: during l1-m4d the stop killed only the harness. The workflow had already
# been submitted, so it kept running another 27 minutes and burned 7.61M tokens (docs/173 sec.3
# errata). Killing the CLI is NOT stopping the batch. Same contract as l1-m4f-stop.sh.
#
# Usage: bash packages/eval/scripts/sm-tier-probe-stop.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
PORT="${SM_PROBE_PORT:-47558}"

echo "stopping sm-tier-probe roles..."
for pat in "[s]m-tier-probe.sh" "[s]rc/cli.ts --fixtures" "[c]affeinate -s -d -i"; do
  pkill -f "$pat" 2>/dev/null && echo "killed: $pat"
done
pkill -f "[s]leep 1800" 2>/dev/null && echo "killed: stray sleep 1800"
sleep 2
echo "--- remaining ---"
pgrep -fl "[s]m-tier-probe" | head -5
pgrep -fl "[s]rc/cli.ts" | head -4
echo "(empty above = clean)"

echo "cancelling running workflows on :$PORT..."
set -a; source "$ROOT/.env"; set +a
IDS=$(docker exec ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c \
  "select id from workflow_runs where status in ('RUNNING','PENDING');")
if [ -z "$IDS" ]; then
  echo "none running"
else
  for id in $IDS; do
    code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/workflows/$id/cancel" || true)
    echo "cancelled $id (http=$code)"
  done
fi

echo "--- verifying no RUNNING/PENDING remain ---"
docker exec -i ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select id, status, updated_at from workflow_runs where status in ('RUNNING','PENDING');"
echo "done"
