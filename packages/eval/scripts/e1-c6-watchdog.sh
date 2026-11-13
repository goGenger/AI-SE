#!/usr/bin/env bash
# C-6 watchdog: detects system sleep (baseline pmset sleep count) and batch death.
# Exits when the batch script disappears (reports whether the completion marker is present).
# NOTE: keep this file ASCII-only.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
BATCH_LOG="/tmp/c6-e1-batch.log"
BASE_SLEEPS=$(pmset -g log 2>/dev/null | grep -c 'Entering Sleep' || true)
prev="$BASE_SLEEPS"
echo "WATCHDOG-START sleep-baseline=$BASE_SLEEPS $(date '+%F %T')"

for i in $(seq 1 2880); do
  now=$(pmset -g log 2>/dev/null | grep -c 'Entering Sleep' || true)
  if [ "$now" -gt "$prev" ]; then
    echo "WATCHDOG-SLEEP $(date '+%F %T') sleep count $prev -> $now"
    prev="$now"
  fi
  if ! pgrep -f '[e]1-c6-split.sh' >/dev/null 2>&1; then
    if grep -q 'E1_C6_ALL_COMPLETE' "$BATCH_LOG" 2>/dev/null; then
      echo "WATCHDOG-DONE batch complete $(date '+%F %T')"
    else
      echo "WATCHDOG-DEATH batch process gone without completion marker $(date '+%F %T')"
    fi
    exit 0
  fi
  sleep 60
done
echo "WATCHDOG-TIMEOUT after 48h"
