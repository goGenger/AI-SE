#!/usr/bin/env bash
# E-4 demo: AI-SE capability tour (reproducible terminal capture) - docs/125 E-4.
# Run: bash packages/eval/scripts/e4-demo.sh   (its output IS the capture; tee it to a file)
# Optional console: VITE_API_BASE_URL=http://127.0.0.1:47557 corepack pnpm --filter @ai-se/web dev
# NOTE: keep this file ASCII-only.

set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "$(dirname "$0")/../../.."
BASE="http://127.0.0.1:47557"
E1_REQ="a30f30cc-64f5-4b31-9bbb-9b3d5bbaba53"
WF_FLIP="ba500ded-ebff-4003-b500-c8d675340ff3"

step() { echo; echo "===== $* ====="; }
db() {
  set -a; source .env; set +a
  docker exec -i ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@" </dev/null
}

step "1/7 platform health (controlled instance :47557)"
curl -s -o /dev/null -w 'GET /health -> %{http_code}\n' --max-time 5 "$BASE/health"
curl -s -o /dev/null -w 'GET /ready  -> %{http_code}\n' --max-time 5 "$BASE/ready"

step "2/7 projects & requirements (real data via API)"
curl -s --max-time 10 "$BASE/api/projects" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print('projects:', len(d)); [print(' -', p['name']) for p in d[:6]]"

step "3/7 E-1 flagship: slice-1 fully SUCCESS + live E-0(a) red-light flip"
db -c "SELECT task_key, type, status FROM tasks WHERE workflow_run_id='$WF_FLIP' ORDER BY created_at;" | head -20
echo "-- T-13 check verdict (expected flipped to pass = C-6 misfire fixed) --"
db -t -A -c "SELECT task_key, output->'verification'->'checks'->0->>'expected', output->'verification'->'checks'->0->>'passed' FROM tasks WHERE workflow_run_id='$WF_FLIP' AND task_key='T-13';"

step "4/7 AC traceability (FR -> AC -> test -> result -> evidence)"
curl -s --max-time 10 "$BASE/api/requirements/$E1_REQ/traceability" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; s=d['summary']; print('total', s['total'], '| passed', s['passed'], '| failed', s['failed'], '| unverified', s['unverified'], '| noTest', s['noTest']); c=d['criteria'][0]; print('sample:', c['acKey'], c['status'], '|', c['text'][:70])"

step "5/7 delivery chain (D-5 drill: environments & deployment records)"
db -c "SELECT name, endpoint FROM deployment_environments ORDER BY name;" | head -8
db -c "SELECT environment, operation, status, left(git_commit,8) AS commit FROM deployments ORDER BY created_at DESC LIMIT 8;" | head -14

step "6/7 audit & verification trail (sample: the flipped task's full checks record)"
db -t -A -c "SELECT jsonb_pretty(output->'verification') FROM tasks WHERE workflow_run_id='$WF_FLIP' AND task_key='T-13';" | head -32

step "7/7 evidence index"
ls packages/eval/results/e/evidence/ | head -20
echo "-- D-phase delivery evidence --"
ls packages/eval/results/d/evidence/ | head -10
echo
echo "DEMO COMPLETE."
