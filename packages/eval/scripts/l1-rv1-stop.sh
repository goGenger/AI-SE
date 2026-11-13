#!/usr/bin/env bash
# L1-rv1 batch clean-stop: kills batch process roles AND cancels server-side workflows.
# Patterns scoped to THIS batch only. Also matches the watchdog argv that carries the batch pattern.
#
# Usage: bash packages/eval/scripts/l1-rv1-stop.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
PORT="${L1_RV1_PORT:-47558}"

echo "stopping l1-rv1 batch roles..."
for pat in "[l]1-rv1-e1-x3.sh" "[l]1-rv1" "[s]rc/cli.ts --fixtures E1" "[c]affeinate -s -d -i"; do
  pkill -f "$pat" 2>/dev/null && echo "killed: $pat"
done
pkill -f "[s]leep 300" 2>/dev/null && echo "killed: stray sleep 300"
sleep 2
echo "--- remaining ---"
pgrep -fl "[l]1-rv1" | head -5
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
