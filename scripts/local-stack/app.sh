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
# next/font downloads Google Fonts at build time; that fetch fails now and then, so retry up to 3 times.
if [ ! -f "$STATE/built" ]; then
  for attempt in 1 2 3; do
    with_stack_env npx next build >"$STATE/build.log" 2>&1 && { touch "$STATE/built"; break; }
    echo "build attempt $attempt failed" >&2
    [ "$attempt" = 3 ] && { grep -m3 -iE "error" "$STATE/build.log" >&2; exit 1; }
  done
fi
with_stack_env node "$HERE/proc.mjs" start "$STATE/app.pid" "$STATE/app.log" -- npx next start -p "$APP_PORT" -H 127.0.0.1
for _ in $(seq 1 60); do
  curl -fs -o /dev/null "http://127.0.0.1:${APP_PORT}/login" && { echo "app ready on 127.0.0.1:${APP_PORT}"; exit 0; }
  sleep 1
done
echo "app did not start" >&2; exit 1
