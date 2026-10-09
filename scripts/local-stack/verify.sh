#!/usr/bin/env bash
# Runs the three suites: 13 SQL quota tests, 18 isolation checks, 10 chat checks.
# The chat suite needs the app (app.sh); pass --no-app to run only the first two.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$ROOT/.local-stack"
[ -f "$STATE/env" ] || { echo "run up.sh first" >&2; exit 1; }
cd "$ROOT"
set -a
# shellcheck disable=SC1091
. "$STATE/env"
set +a
status=0
echo "== 1. free audit quota, SQL on a scratch database (expects 13 pass)"
FREE_AUDIT_PG_URL="$LOCAL_SCRATCH_DB" npx tsx --test tests/free-audit-sql.integration.test.ts 2>&1 | grep -E "^# (tests|pass|fail|skipped)" || status=1
echo "== 2. account isolation and quota through Auth and REST (expects 18 of 18)"
node "$HERE/isolation.mjs" || status=1
if [ "${1:-}" != "--no-app" ]; then
  echo "== 3. chat routes with real session cookies (expects 10 of 10)"
  node "$HERE/chat.mjs" || status=1
fi
exit $status
