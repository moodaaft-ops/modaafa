#!/usr/bin/env bash
# Runs: preflight and Docker-selection tests, 16 posture and privilege checks, 13 SQL quota tests,
# 18 isolation checks, 10 chat checks. The chat suite needs the app (app.sh); pass --no-app to skip it.
# Every suite runs with an empty environment plus .local-stack/env.
# Exit code 0 only when every suite reports exactly the expected numbers. A skipped SQL test is a
# failure: those tests skip silently when FREE_AUDIT_PG_URL is missing, and a skip proves nothing.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$ROOT/.local-stack"
# shellcheck disable=SC1091
. "$HERE/common.sh"
EXPECTED_SQL_PASS=13
EXPECTED_GUARD_PASS=27   # preflight.test.mjs (19) + common.test.mjs (8)
[ -f "$STATE/env" ] || { echo "run up.sh first" >&2; exit 1; }
cd "$ROOT"
node "$HERE/preflight.mjs" envfile "$STATE/env" || exit 1
# Same Docker daemon that up.sh chose (recorded in .local-stack/docker-host), whatever this shell has selected.
use_stack_docker || exit 1
status=0

# require_summary <label> <rc> <output> <expected-pass>: node --test summary must read
# tests=pass=<expected>, fail=0, skipped=0, cancelled=0, and the command must have exited 0.
require_summary() {
  local label="$1" rc="$2" out="$3" want="$4" field got bad=""
  echo "$out" | grep -E "^# (tests|pass|fail|cancelled|skipped|todo) "
  for field in tests pass fail cancelled skipped todo; do
    got="$(echo "$out" | sed -n "s/^# $field \([0-9][0-9]*\).*/\1/p" | head -n1)"
    case "$field" in
      tests | pass) [ "$got" = "$want" ] || bad="$bad $field=${got:-missing}(want $want)" ;;
      *) [ "$got" = "0" ] || bad="$bad $field=${got:-missing}(want 0)" ;;
    esac
  done
  [ "$rc" = 0 ] || bad="$bad exit=$rc(want 0)"
  if [ -n "$bad" ]; then
    echo "FAIL $label:$bad"
    status=1
  fi
}

echo "== 0a. preflight refusals, Docker daemon selection and clean-environment propagation (expects $EXPECTED_GUARD_PASS pass, 0 skipped)"
guard_out="$(node --test "$HERE/preflight.test.mjs" "$HERE/common.test.mjs" 2>&1)"
require_summary "guard tests" $? "$guard_out" "$EXPECTED_GUARD_PASS"
echo "== 0b. stack posture and privilege parity with the migrations (expects 16 of 16)"
# posture.mjs is the only child that talks to Docker, so only it receives DOCKER_HOST.
with_stack_env env DOCKER_HOST="$DOCKER_HOST" node "$HERE/posture.mjs" || status=1
echo "== 1. free audit quota, SQL on a scratch database (expects $EXPECTED_SQL_PASS pass, 0 skipped, 0 fail)"
sql_out="$(with_stack_env bash -c 'FREE_AUDIT_PG_URL="$LOCAL_SCRATCH_DB" exec npx tsx --test tests/free-audit-sql.integration.test.ts' 2>&1)"
require_summary "free-audit SQL suite" $? "$sql_out" "$EXPECTED_SQL_PASS"
echo "== 2. account isolation and quota through Auth and REST (expects 18 of 18)"
with_stack_env node "$HERE/isolation.mjs" || status=1
if [ "${1:-}" != "--no-app" ]; then
  echo "== 3. chat routes with real session cookies (expects 10 of 10)"
  with_stack_env node "$HERE/chat.mjs" || status=1
fi
[ "$status" = 0 ] && echo "verify: all suites passed" || echo "verify: FAILED" >&2
exit $status
