#!/usr/bin/env bash
# E tonight chain (2026-10-07): wait for the E-2b batch to finish, then launch the
# E-1 batch with the 07:45 CST deadline (no NEW run starts at/after the deadline;
# in-flight runs finish naturally; completed runs are checkpointed by split mode).
# Usage: launched detached (double-fork) so it survives app restarts.
# NOTE: keep this file ASCII-only.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."

log() { echo "[$(date '+%F %T %Z')] $*"; }

log "chain started; waiting for e2b batch to finish"
while pgrep -f '[e]2b-sml-split.sh' >/dev/null 2>&1; do sleep 60; done
log "e2b batch ended; settling 120s before E-1 launch"
sleep 120

export E1_DEADLINE_EPOCH=1791416700   # 2026-10-08 07:45:00 +08:00
bash packages/eval/scripts/e1-launch.sh
log "e1-launch exit=$?"
