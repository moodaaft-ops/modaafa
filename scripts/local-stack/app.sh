#!/usr/bin/env bash
# Builds and starts the app (production build) against the local stack on 127.0.0.1.
# Refuses to run when a real .env file is present, so production values can never be loaded.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$ROOT/.local-stack"
[ -f "$STATE/env" ] || { echo "run up.sh first" >&2; exit 1; }
cd "$ROOT"
for f in .env .env.local .env.production .env.production.local .env.development.local; do
  [ -e "$f" ] && { echo "Found $f. Move it aside first so no real value can be loaded." >&2; exit 1; }
done
set -a
# shellcheck disable=SC1091
. "$STATE/env"
set +a
# NEXT_PUBLIC_* values are baked at build time, so every new stack gets its own build.
# next/font downloads Google Fonts at build time; that fetch fails now and then, so retry up to 3 times.
if [ ! -f "$STATE/built" ]; then
  for attempt in 1 2 3; do
    npx next build >"$STATE/build.log" 2>&1 && { touch "$STATE/built"; break; }
    echo "build attempt $attempt failed" >&2
    [ "$attempt" = 3 ] && { grep -m3 -iE "error" "$STATE/build.log" >&2; exit 1; }
  done
fi
setsid nohup npx next start -p "$APP_PORT" -H 127.0.0.1 >"$STATE/app.log" 2>&1 & echo $! >"$STATE/app.pid"
for _ in $(seq 1 60); do
  curl -fs -o /dev/null "http://127.0.0.1:${APP_PORT}/login" && { echo "app ready on 127.0.0.1:${APP_PORT}"; exit 0; }
  sleep 1
done
echo "app did not start" >&2; exit 1
