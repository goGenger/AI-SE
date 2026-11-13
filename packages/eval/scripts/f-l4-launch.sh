#!/usr/bin/env bash
# F-phase L4 batch launcher: preflight + DETACHED launch (double-fork + setsid) of the
# E1 x3 batch and its watchdog, so both survive Hermes app restarts / session cleanups.
# Prints E1_L4_LAUNCHED / LAUNCH_ABORTED:<reason> / LAUNCH_FAILED.
# NOTE: keep this file ASCII-only.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
BASE_URL="http://127.0.0.1:47557"
WEEK_START="2026-10-11 23:00:00+00"
GUARD_LIMIT=20000000

health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/health" || true)
if [ "$health" != "200" ]; then
  echo "LAUNCH_ABORTED: platform unhealthy (health=$health). Run f-l4-server-launch.sh first."
  exit 4
fi

if pgrep -f '[f]-l4-e1-x3.sh' >/dev/null 2>&1; then
  echo "LAUNCH_ABORTED: batch already running."
  exit 5
fi

. "$ROOT/packages/eval/scripts/lib/usage-guard.sh"
used=$(week_tokens)
case "$used" in
  ''|*[!0-9]*) echo "LAUNCH_ABORTED: cannot read weekly usage ($used)."; exit 3 ;;
esac
if [ "$used" -ge "$GUARD_LIMIT" ]; then
  echo "LAUNCH_ABORTED: weekly usage $used >= limit $GUARD_LIMIT."
  exit 2
fi
echo "PREFLIGHT_OK: health=200 weekly_used=$used"

python3 - "$ROOT" <<'PYEOF'
import os, sys
root = sys.argv[1]
pid = os.fork()
if pid > 0:
    sys.exit(0)
os.setsid()
pid2 = os.fork()
if pid2 > 0:
    sys.exit(0)
os.chdir(root)
env = dict(os.environ)
env["PATH"] = os.path.expanduser("~/.nvm/versions/node/v22.22.2/bin") + ":" + env.get("PATH", "")
with open("/tmp/f-l4-batch.pid", "w") as f:
    f.write(str(os.getpid()))
log = open("/tmp/f-l4-batch.log", "ab")
os.dup2(log.fileno(), 1); os.dup2(log.fileno(), 2)
os.execvpe("/usr/bin/caffeinate", ["caffeinate", "-s", "-d", "-i", "bash", "packages/eval/scripts/f-l4-e1-x3.sh"], env)
PYEOF

python3 - "$ROOT" <<'PYEOF'
import os, sys
root = sys.argv[1]
pid = os.fork()
if pid > 0:
    sys.exit(0)
os.setsid()
pid2 = os.fork()
if pid2 > 0:
    sys.exit(0)
os.chdir(root)
env = dict(os.environ)
env["PATH"] = os.path.expanduser("~/.nvm/versions/node/v22.22.2/bin") + ":" + env.get("PATH", "")
with open("/tmp/f-l4-watchdog.pid", "w") as f:
    f.write(str(os.getpid()))
log = open("/tmp/f-l4-watchdog.log", "ab")
os.dup2(log.fileno(), 1); os.dup2(log.fileno(), 2)
os.execvpe("bash", ["bash", "packages/eval/scripts/f-l4-watchdog.sh"], env)
PYEOF

sleep 12
if pgrep -f '[f]-l4-e1-x3.sh' >/dev/null 2>&1; then
  echo "E1_L4_LAUNCHED: batch_pid=$(cat /tmp/f-l4-batch.pid) watchdog_pid=$(cat /tmp/f-l4-watchdog.pid)"
  tail -3 /tmp/f-l4-batch.log
  echo "E1_L4_LAUNCHED_DONE"
else
  echo "LAUNCH_FAILED: batch process not detected after launch"
  tail -8 /tmp/f-l4-batch.log 2>/dev/null
  exit 6
fi
