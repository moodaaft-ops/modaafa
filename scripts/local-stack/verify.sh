#!/usr/bin/env bash
# Runs: 12 preflight refusal tests, 16 posture and privilege checks, 13 SQL quota tests, 18 isolation checks, 10 chat checks.
# The chat suite needs the app (app.sh); pass --no-app to skip it.
# Every suite runs with an empty environment plus .local-stack/env.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$ROOT/.local-stack"
# shellcheck disable=SC1091
. "$HERE/common.sh"
[ -f "$STATE/env" ] || { echo "run up.sh first" >&2; exit 1; }
cd "$ROOT"
node "$HERE/preflight.mjs" envfile "$STATE/env" || exit 1
status=0
echo "== 0a. preflight refusals: production, remote hosts, ?host= overrides, remote Docker (expects 12 pass)"
pre_out="$(node --test "$HERE/preflight.test.mjs" 2>&1)"
echo "$pre_out" | grep -E "^# (tests|pass|fail)"
echo "$pre_out" | grep -q "^# fail 0" || status=1
echo "== 0b. stack posture and privilege parity with the migrations (expects 16 of 16)"
with_stack_env node "$HERE/posture.mjs" || status=1
echo "== 1. free audit quota, SQL on a scratch database (expects 13 pass)"
sql_out="$(with_stack_env bash -c 'FREE_AUDIT_PG_URL="$LOCAL_SCRATCH_DB" exec npx tsx --test tests/free-audit-sql.integration.test.ts' 2>&1)"
echo "$sql_out" | grep -E "^# (tests|pass|fail|skipped)"
echo "$sql_out" | grep -q "^# fail 0" || status=1
echo "== 2. account isolation and quota through Auth and REST (expects 18 of 18)"
with_stack_env node "$HERE/isolation.mjs" || status=1
if [ "${1:-}" != "--no-app" ]; then
  echo "== 3. chat routes with real session cookies (expects 10 of 10)"
  with_stack_env node "$HERE/chat.mjs" || status=1
fi
exit $status
