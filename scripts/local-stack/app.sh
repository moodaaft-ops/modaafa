#!/usr/bin/env bash
# Builds and starts the app (production build) against the local stack on 127.0.0.1.
# Refuses to run when any env-style file is present in the repo root (Next.js would load it), and runs
# build and server with an EMPTY environment plus the generated .local-stack/env, so no value from the
# caller's shell can reach the app.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$ROOT/.local-stack"
# shellcheck disable=SC1091
. "$HERE/versions.env"
# shellcheck disable=SC1091
. "$HERE/common.sh"
[ -f "$STATE/env" ] || { echo "run up.sh first" >&2; exit 1; }
cd "$ROOT"

node "$HERE/preflight.mjs" env
node "$HERE/preflight.mjs" envfile "$STATE/env"

# Next.js loads .env, .env.local, .env.<mode> and .env.<mode>.local. Block all of those and any other
# env-looking file in the root (.env.development, .env.test*, production.env, test.env, env.test, ...).
# Only the committed templates (.example, .sample, .template) are allowed.
blocked="$(find . -maxdepth 1 \( -type f -o -type l \) \( \
    -name '.env' -o -name '.env.*' -o -name '*.env' -o -name '*.env.*' -o -name 'env.*' \
    -o -name '*test*env*' -o -name '*env*test*' \) \
  | sed 's|^\./||' | grep -Ev '\.(example|sample|template)$' || true)"
if [ -n "$blocked" ]; then
  echo "Found env-style file(s) in the repo root. Move them aside first so no real value can be loaded:" >&2
  echo "$blocked" | sed 's/^/  /' >&2
  exit 1
fi

# NEXT_PUBLIC_* values are baked at build time, so every new stack gets its own build.
# The build runs under run-timed.mjs: a hard time limit, an idle limit, a stage log, and on a stop it
# ends only the build's own process tree. Limits (whole seconds) can be changed for a slow machine:
#   LS_BUILD_TIMEOUT (default 900)   LS_BUILD_IDLE_TIMEOUT (default 300)
BUILD_TIMEOUT="${LS_BUILD_TIMEOUT:-900}"
BUILD_IDLE="${LS_BUILD_IDLE_TIMEOUT:-300}"
case "$BUILD_TIMEOUT$BUILD_IDLE" in *[!0-9]* | "") echo "LS_BUILD_TIMEOUT and LS_BUILD_IDLE_TIMEOUT must be whole numbers of seconds." >&2; exit 2 ;; esac
NEXT_BIN="node_modules/next/dist/bin/next"
[ -f "$NEXT_BIN" ] || { echo "Dependencies are missing ($NEXT_BIN). Run: npm ci" >&2; exit 1; }
if [ ! -f "$STATE/built" ]; then
  # Called directly with node (no npx, which can reach for the registry), and with Next telemetry off so the
  # build makes no outbound call of its own. Fonts are still fetched from Google (next/font).
  for attempt in 1 2 3; do
    echo "build attempt $attempt (limit ${BUILD_TIMEOUT}s, idle ${BUILD_IDLE}s; log .local-stack/build.log)"
    : >"$STATE/build.log"   # one attempt per log, so the font check below never reads an older attempt
    code=0
    with_stack_env env NEXT_TELEMETRY_DISABLED=1 node "$HERE/run-timed.mjs" --label build \
      --timeout "$BUILD_TIMEOUT" --idle "$BUILD_IDLE" --log "$STATE/build.log" --env-file "$STATE/env" \
      -- node "$NEXT_BIN" build || code=$?
    if [ "$code" = 0 ]; then touch "$STATE/built"; break; fi
    case "$code" in
      124 | 125) echo "Build stopped (exit $code). Not retrying a build that hung; see the stage log above." >&2; exit 1 ;;
      126 | 129 | 130 | 143) exit "$code" ;;
    esac
    # Only the known flaky step is retried: the Google Fonts download. Any other failure is a real build error.
    if [ "$attempt" -lt 3 ] && tail -n 200 "$STATE/build.log" | grep -qiE "failed to fetch .*(font|google)|fonts\.(googleapis|gstatic)\.com"; then
      echo "build attempt $attempt failed while fetching fonts; retrying" >&2
      continue
    fi
    echo "Build failed (exit $code)." >&2
    exit 1
  done
fi
with_stack_env node "$HERE/proc.mjs" start "$STATE/app.pid" "$STATE/app.log" -- npx next start -p "$APP_PORT" -H 127.0.0.1
for _ in $(seq 1 60); do
  curl -fs --max-time 3 -o /dev/null "http://127.0.0.1:${APP_PORT}/login" && { echo "app ready on 127.0.0.1:${APP_PORT}"; exit 0; }
  sleep 1
done
echo "app did not start" >&2; exit 1
