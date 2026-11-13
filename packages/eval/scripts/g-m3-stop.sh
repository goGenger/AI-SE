#!/usr/bin/env bash
# G-M3 batch clean-stop: kills ALL batch process roles (bracket patterns avoid pgrep self-match)
# and cancels any RUNNING/PENDING workflows. Usage: bash packages/eval/scripts/g-m3-stop.sh
set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"

echo "stopping g-m3 batch roles..."
for pat in "[g]-m3-now.sh" "[g]-m3-batch.sh" "[g]-m3-e1-x3.sh" "[g]-m3-l3.sh" "[g]-m3-e1-run2b.sh" "[g]-m3-continue.sh" "[c]affeinate -s -d -i" "[s]rc/cli.ts --fixtures"; do
  pkill -f "$pat" 2>/dev/null && echo "killed: $pat"
done
pkill -f "[s]leep 1800" 2>/dev/null && echo "killed: stray sleep 1800"
sleep 2
echo "--- remaining ---"
pgrep -fl "[g]-m3" | head -5
pgrep -fl "[s]rc/cli.ts" | head -4
echo "(empty above = clean)"

echo "cancelling running workflows..."
IDS=$(docker exec ai-se-postgres-1 psql -U aise -d aise -t -A -c "select id from workflow_runs where status in ('RUNNING','PENDING');")
for id in $IDS; do
  curl -s -m 10 -X POST "http://127.0.0.1:47557/api/workflows/$id/cancel" >/dev/null && echo "cancelled $id"
done
echo "done"
