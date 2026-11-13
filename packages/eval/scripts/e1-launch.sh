#!/usr/bin/env bash
# E-1 launcher (docs/125): preflight + detached launch of the E1 x3 batch and its watchdog.
# Prints a single status block: E1_LAUNCHED / E1_LAUNCH_ABORTED:<reason> / E1_LAUNCH_FAILED.
# NOTE: keep this file ASCII-only. Mojibake in shell scripts breaks execution.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"

OUT_DIR="$ROOT/packages/eval/results/e1"
if [ -f "$OUT_DIR/run-1.json" ] && [ -f "$OUT_DIR/run-2.json" ] && [ -f "$OUT_DIR/run-3.json" ]; then
  echo "E1_ALREADY_COMPLETE: all 3 run results present in results/e1"
  exit 0
fi

WEEK_START="2026-10-11 23:00:00+00"
GUARD_LIMIT=20000000
BASE_URL="http://127.0.0.1:47557"

health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/health" || true)
if [ "$health" != "200" ]; then
  echo "E1_LAUNCH_ABORTED: platform unhealthy (health=$health). Restart the controlled instance first (detached pattern), then rerun this script."
  exit 4
fi

if pgrep -f '[e]1-split.sh' >/dev/null 2>&1 || pgrep -f '[e]2-sml-split.sh' >/dev/null 2>&1; then
  echo "E1_LAUNCH_ABORTED: another eval batch is already running."
  exit 5
fi

. "$ROOT/packages/eval/scripts/lib/usage-guard.sh"
used=$(week_tokens)
case "$used" in
  ''|*[!0-9]*) echo "E1_LAUNCH_ABORTED: cannot read weekly usage ($used)."; exit 3 ;;
esac
if [ "$used" -ge "$GUARD_LIMIT" ]; then
  echo "E1_LAUNCH_ABORTED: weekly usage $used >= limit $GUARD_LIMIT."
  exit 2
fi
echo "E1_PREFLIGHT_OK: health=200 weekly_used=$used (window since $WEEK_START)"

python3 - <<'PYEOF'
import os, sys
pid = os.fork()
if pid > 0:
    sys.exit(0)
os.setsid()
pid2 = os.fork()
if pid2 > 0:
    sys.exit(0)
os.chdir("/Users/shixianbao/Desktop/study/AI_SE")
env = dict(os.environ)
env["PATH"] = os.path.expanduser("~/.nvm/versions/node/v22.22.2/bin") + ":" + env.get("PATH", "")
with open("/tmp/e1-batch.pid", "w") as f:
    f.write(str(os.getpid()))
log = open("/tmp/e1-batch.log", "ab")
os.dup2(log.fileno(), 1); os.dup2(log.fileno(), 2)
os.execvpe("/usr/bin/caffeinate", ["caffeinate", "-s", "-d", "-i", "bash", "packages/eval/scripts/e1-split.sh"], env)
PYEOF

python3 - <<'PYEOF'
import os, sys
pid = os.fork()
if pid > 0:
    sys.exit(0)
os.setsid()
pid2 = os.fork()
if pid2 > 0:
    sys.exit(0)
os.chdir("/Users/shixianbao/Desktop/study/AI_SE")
env = dict(os.environ)
env["PATH"] = os.path.expanduser("~/.nvm/versions/node/v22.22.2/bin") + ":" + env.get("PATH", "")
with open("/tmp/e1-watchdog.pid", "w") as f:
    f.write(str(os.getpid()))
log = open("/tmp/e1-watchdog.log", "ab")
os.dup2(log.fileno(), 1); os.dup2(log.fileno(), 2)
os.execvpe("bash", ["bash", "packages/eval/scripts/e1-watchdog.sh"], env)
PYEOF

sleep 12
if pgrep -f '[e]1-split.sh' >/dev/null 2>&1; then
  echo "E1_LAUNCHED: batch_pid=$(cat /tmp/e1-batch.pid) watchdog_pid=$(cat /tmp/e1-watchdog.pid)"
  tail -4 /tmp/e1-batch.log
  echo "E1_LAUNCHED_DONE"
else
  echo "E1_LAUNCH_FAILED: batch process not detected after launch"
  tail -8 /tmp/e1-batch.log 2>/dev/null
  exit 6
fi
