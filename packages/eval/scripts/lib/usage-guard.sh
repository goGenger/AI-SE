#!/usr/bin/env bash
# PL-M15 (docs/176 sec.7 item 3): the weekly quota guard's reading rule, defined ONCE.
#
# Why: N-8 lets a single agent run record an absurd `token_usage.input_tokens` (10^14..10^18).
# One such row used to defeat the stop-line outright, and it happened twice -- L1-M4f run 2 and
# the cheap-tier probe (docs/177). The rule is now "ignore any single run above a defensible
# upper bound". That bound, and the summing rule, live in `packages/eval/src/usageGuard.ts`;
# this file only fetches the raw values and pipes them through it, so there is exactly one
# implementation of the rule and no per-script copy to drift.
#
# Callers MUST keep their own non-numeric fail-safe:
#     case "$used" in ''|*[!0-9]*) log "BUDGET-GUARD: cannot read weekly usage"; exit 3 ;; esac
# If the database or the filter cannot be read, week_tokens prints nothing and that fail-safe
# aborts the batch. The guard must never fail OPEN.
#
# Requires the caller to have set ROOT and WEEK_START.
# NOTE: keep this file ASCII-only.
week_tokens() {
  set -a; source "$ROOT/.env"; set +a
  local raw
  raw=$(docker exec -i ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c \
    "SELECT token_usage->>'input_tokens' FROM agent_runs WHERE created_at >= '$WEEK_START';" 2>/dev/null) || {
    echo ""
    return 1
  }
  printf '%s\n' "$raw" | "$ROOT/node_modules/.bin/tsx" "$ROOT/packages/eval/src/usageGuardCli.ts" 2>/dev/null
}
