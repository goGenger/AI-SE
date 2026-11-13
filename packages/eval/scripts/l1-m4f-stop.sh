#!/usr/bin/env bash
# L1-M4f batch clean-stop: kills ALL batch process roles (bracket patterns avoid pgrep self-match)
# and cancels any RUNNING/PENDING workflows on the dedicated :47558 instance.
#
# WHY THIS EXISTS: during l1-m4d the stop killed only the harness. The workflow had already been
# submitted to the server, so it kept running for another 27 minutes and burned 7.61M tokens
# (run 3, 2026-10-17 06:29 -> 06:55:47 UTC). Killing the CLI is NOT stopping the batch - the
# server-side workflow has to be cancelled too. Same contract as g-m3-stop.sh / l1-m4e-stop.sh.
#
# Usage: bash packages/eval/scripts/l1-m4f-stop.sh
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
PORT="${L1_M4F_PORT:-47558}"

echo "stopping l1-m4f batch roles..."
for pat in "[l]1-m4f-e1-x3.sh" "[l]1-m4f" "[s]rc/cli.ts --fixtures E1" "[c]affeinate -s -d -i"; do
  pkill -f "$pat" 2>/dev/null && echo "killed: $pat"
done
pkill -f "[s]leep 1800" 2>/dev/null && echo "killed: stray sleep 1800"
sleep 2
echo "--- remaining ---"
pgrep -fl "[l]1-m4f" | head -5
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
docker exec ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select id, status, updated_at from workflow_runs where status in ('RUNNING','PENDING');"
echo "done"
