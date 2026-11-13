#!/usr/bin/env bash
# F-phase L3 stop sentinel (user directive 2026-10-09): end the batch right after
# "M3 run 3 done" appears in the batch log, so L1/L2 are deferred to the next
# quota window. Runs alongside f-l3-sml-split.sh + f-l3-watchdog.sh.
# NOTE: keep this file ASCII-only.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
LOG="/tmp/f-l3-batch.log"
SENT_LOG="/tmp/f-l3-sentinel.log"

echo "SENTINEL-START $(date '+%F %T') waiting for: M3 run 3 done" >> "$SENT_LOG"

for _ in $(seq 1 5760); do   # up to 48h at 30s interval
  if grep -q "M3 run 3 done exit=" "$LOG" 2>/dev/null; then
    echo "SENTINEL-M3R3-DONE $(date '+%F %T') stopping batch before L1" >> "$SENT_LOG"
    sleep 5
    pkill -f "f-l3-sml-split" 2>/dev/null || true
    sleep 2
    pkill -f "cli.mjs src/cli.ts" 2>/dev/null || true
    echo "SENTINEL-STOPPED $(date '+%F %T')" >> "$SENT_LOG"
    exit 0
  fi
  if ! pgrep -f '[f]-l3-sml-split.sh' >/dev/null 2>&1; then
    echo "SENTINEL-BATCH-GONE-WITHOUT-M3R3 $(date '+%F %T') (budget guard or other stop)" >> "$SENT_LOG"
    exit 0
  fi
  sleep 30
done
echo "SENTINEL-TIMEOUT after 48h" >> "$SENT_LOG"
