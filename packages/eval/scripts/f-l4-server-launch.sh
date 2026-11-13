#!/usr/bin/env bash
# F-phase L4 controlled-instance launcher: starts the server as a DETACHED daemon
# (double-fork + setsid) so it survives Hermes app restarts / session cleanups.
# Prints SERVER_ALREADY_UP / SERVER_LAUNCHED:<pid> / SERVER_LAUNCH_FAILED.
# NOTE: keep this file ASCII-only.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
LOG="/tmp/f-l4-server-47557.log"

health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:47557/health" || true)
if [ "$health" = "200" ]; then
  echo "SERVER_ALREADY_UP"
  exit 0
fi

cd "$ROOT/apps/server"
set -a; source "$ROOT/.env"; set +a
export PORT=47557 PLANNING_MODE=two-level VERIFICATION_GATE=enforce SUBMIT_RESULT_MODE=tool

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

sleep 12
health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:47557/health" || true)
if [ "$health" = "200" ]; then
  pid=$(lsof -nP -iTCP:47557 -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')
  echo "SERVER_LAUNCHED:$pid"
else
  echo "SERVER_LAUNCH_FAILED: health=$health"
  tail -5 "$LOG"
  exit 1
fi
