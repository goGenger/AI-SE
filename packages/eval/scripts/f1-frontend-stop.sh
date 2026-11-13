#!/usr/bin/env bash
# F1 batch clean-stop: kills the harness roles AND cancels the server-side workflow.
#
# WHY: killing the harness is NOT a stop - the workflow already created server-side keeps
# running and burning tokens with nobody watching (learned the hard way, batch l1-m4d).
#
# N-58 (docs/232 sec.10): this script used to print "done" unconditionally. A failed cancel
# (platform unreachable -> curl http=000) was reported as success while its own verification
# block printed the workflow still RUNNING. Every step now fails loudly and the final line is
# only reached when the database really has no live workflow.
#
# NOTE: the "[f]1-frontend" pattern also matches this batch's watchdog command line, which
# carries the batch pattern as an argument; that is intended at stop time.
# NOTE: patterns are scoped to THIS batch only.
#
# Usage: bash packages/eval/scripts/f1-frontend-stop.sh
# Exit:  0 = stopped and verified clean; 1 = something could not be stopped/cancelled.
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"

fail=0

echo "stopping f1-frontend batch roles..."
for pat in "[f]1-frontend-x3.sh" "[f]1-frontend" "[s]rc/cli.ts --fixtures F1" "[c]affeinate -s -d -i"; do
  pkill -f "$pat" 2>/dev/null && echo "killed: $pat"
done
pkill -f "[s]leep 300" 2>/dev/null && echo "killed: stray sleep 300"
sleep 2
echo "--- remaining ---"
pgrep -fl "[f]1-frontend" | head -5
pgrep -fl "[s]rc/cli.ts" | head -4
echo "(empty above = clean)"

set -a; source "$ROOT/.env"; set +a
# N-58 root cause: .env sets PORT=3000, so it MUST be re-assigned AFTER sourcing. Assigning
# it before silently loses to .env and every cancel goes to the dev server instead of the
# batch instance (same trap as l1-m4-server-launch.sh). F1_PORT still wins when set.
PORT="${F1_PORT:-47558}"
echo "cancelling running workflows on :$PORT..."
IDS=$(docker exec ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c \
  "select id from workflow_runs where status in ('RUNNING','PENDING','WAITING_APPROVAL');")
if [ -z "$IDS" ]; then
  echo "none running"
else
  for id in $IDS; do
    code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/workflows/$id/cancel" || true)
    case "$code" in
      2??) echo "cancelled $id (http=$code)" ;;
      *)
        # N-58: http=000 means the request never reached the platform. Reporting that as
        # "cancelled" is how a live workflow kept burning tokens after a clean-looking stop.
        echo "FAILED to cancel $id (http=${code:-none}) - platform unreachable on :$PORT?" >&2
        fail=1
        ;;
    esac
  done
fi

echo "--- verifying no RUNNING/PENDING/WAITING_APPROVAL remain ---"
remaining=$(docker exec ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c \
  "select count(*) from workflow_runs where status in ('RUNNING','PENDING','WAITING_APPROVAL');")
docker exec ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select id, status, updated_at from workflow_runs where status in ('RUNNING','PENDING','WAITING_APPROVAL');"

case "${remaining:-}" in
  ''|*[!0-9]*)
    echo "FAILED: cannot read workflow state from the database" >&2
    exit 1
    ;;
  0) ;;
  *)
    echo "FAILED: $remaining workflow(s) still live after cancel" >&2
    fail=1
    ;;
esac

if [ "$fail" -ne 0 ]; then
  echo "NOT DONE: batch processes are gone but workflows or their cancellation failed (see above)." >&2
  echo "  Retry after the platform is reachable, or cancel manually:" >&2
  echo "  curl -X POST http://127.0.0.1:$PORT/api/workflows/<id>/cancel" >&2
  exit 1
fi

echo "done"
