#!/usr/bin/env bash
# L1-M4 controlled-instance launcher: starts a DEDICATED server on port 47558 as a
# detached daemon (double-fork + setsid) so it survives app restarts / session cleanups.
#
# Why a dedicated instance instead of the dev server (:3000): the batch runs for hours and
# must not be disturbed by a dev-server restart (tsx watch restarts on any packages/*/dist
# rebuild). Same isolation contract as the F/G batches.
#
# Env is identical to the G-M3 controlled instance (two-level planning + VERIFICATION_GATE
# =enforce + tool submit) so the staging-segment numbers stay comparable with the G baseline.
#
# NOTE: the pre-existing :47557 instance was started 2026-10-14, BEFORE autonomy L1 landed,
# so it does NOT carry the L1 code. It is left untouched; this launcher uses :47558.
#
# Prints SERVER_ALREADY_UP / SERVER_LAUNCHED:<pid> / SERVER_LAUNCH_FAILED.
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
PORT="${L1_M4_PORT:-47558}"
LOG="${L1_M4_SERVER_LOG:-/tmp/l1-m4-server-$PORT.log}"

health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/health" || true)
if [ "$health" = "200" ]; then
  echo "SERVER_ALREADY_UP"
  exit 0
fi

cd "$ROOT/apps/server"
set -a; source "$ROOT/.env"; set +a
# IMPORTANT: .env sets PORT=3000, so the port must be re-assigned AFTER sourcing - assigning it
# before the `source` silently loses to .env (this bit the first launch: the server came up on
# :3000 instead of the dedicated port).
PORT="${L1_M4_PORT:-47558}"
# Product default is frontend-vue (docs/235; 2026-11-04). Override with CAPABILITY_PROFILE=backend-node for legacy E1.
export CAPABILITY_PROFILE="${CAPABILITY_PROFILE:-frontend-vue}"
# Keep OpenCode path: prefer process LLM_PROVIDER, else .env, else openai (never silently mock).
export LLM_PROVIDER="${LLM_PROVIDER:-openai}"
export PORT PLANNING_MODE=two-level VERIFICATION_GATE=enforce SUBMIT_RESULT_MODE=tool

python3 - "$ROOT" "$LOG" <<'PYEOF'
import os, sys
root, log_path = sys.argv[1], sys.argv[2]
pid = os.fork()
if pid > 0:
    sys.exit(0)
os.setsid()
pid2 = os.fork()
if pid2 > 0:
    sys.exit(0)
os.chdir(os.path.join(root, "apps", "server"))
env = dict(os.environ)
env["PATH"] = os.path.expanduser("~/.nvm/versions/node/v22.22.2/bin") + ":" + env.get("PATH", "")
log = open(log_path, "ab")
os.dup2(log.fileno(), 1); os.dup2(log.fileno(), 2)
os.execvpe(os.path.join(root, "node_modules", ".bin", "tsx"), ["tsx", "src/index.ts"], env)
PYEOF

sleep 3
listener=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/health" || true)
# Both checks are required: a 200 alone can come from whatever else answers, and a listener alone
# can be a server that came up unhealthy.
if [ -n "$listener" ] && [ "$health" = "200" ]; then
  echo "SERVER_LAUNCHED:$listener"
else
  echo "SERVER_LAUNCH_FAILED:health=$health listener=${listener:-none} (log: $LOG)"
  exit 1
fi
