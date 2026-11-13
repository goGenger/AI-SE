#!/usr/bin/env bash
# F-phase L4 auto-resume daemon: probes the OpenCode Go endpoint every 10 minutes;
# when the provider unblocks (monthly limit reset or balance fallback enabled),
# ensures the platform server is up and relaunches the L4 batch + watchdog via
# f-l4-launch.sh. Logs to /tmp/f-l4-autoresume.log. Runs detached (setsid).
# NOTE: keep this file ASCII-only.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
LOG="/tmp/f-l4-autoresume.log"
MAX_ITERS="${F_L4_RESUME_MAX_ITERS:-432}"   # 432 x 600s = 72h

log() { echo "[$(date '+%F %T %Z')] $*"; }

set -a; source "$ROOT/.env"; set +a
URL="${OPENAI_BASE_URL%/}/chat/completions"

log "AUTORESUME-START max_iters=$MAX_ITERS url=$URL model=$OPENAI_MODEL"

for i in $(seq 1 "$MAX_ITERS"); do
  if grep -q 'F_L4_E1_ALL_COMPLETE' /tmp/f-l4-batch.log 2>/dev/null; then
    log "batch already complete - exit"; exit 0
  fi
  if pgrep -f '[f]-l4-e1-x3.sh' >/dev/null 2>&1; then
    log "batch already running - wait"; sleep 600; continue
  fi

  code=$(curl -s -o /tmp/f-l4-probe.json -w '%{http_code}' --max-time 30 "$URL" \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -H "Content-Type: application/json" \
    -H "x-opencode-session: ai-se-l4-autoresume" \
    -d "{\"model\": \"$OPENAI_MODEL\", \"messages\": [{\"role\": \"user\", \"content\": \"ping\"}], \"max_tokens\": 5}" || true)
  body=$(head -c 200 /tmp/f-l4-probe.json 2>/dev/null)
  log "probe http=$code body=$body"

  if [ "$code" = "200" ]; then
    log "provider OK -> ensuring server, then launching batch"
    bash "$ROOT/packages/eval/scripts/f-l4-server-launch.sh" >> "$LOG" 2>&1 || true
    out=$(bash "$ROOT/packages/eval/scripts/f-l4-launch.sh" 2>&1 || true)
    log "launch output: $out"
    if echo "$out" | grep -q 'E1_L4_LAUNCHED'; then
      log "AUTORESUME-DONE batch relaunched"; exit 0
    else
      log "launch did not start batch - will retry next cycle"
    fi
  fi
  sleep 600
done
log "AUTORESUME-TIMEOUT after $MAX_ITERS iterations"
