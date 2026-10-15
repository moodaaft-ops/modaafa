#!/usr/bin/env bash
# Rebuilds nothing unless asked. Usage: scripts/landing-shots/run.sh [build] [capture-step ...]
#   scripts/landing-shots/run.sh build        build the app against the fake backend first (needed once, or after a pull)
#   scripts/landing-shots/run.sh              capture every screen into ./landing-shots-out
#   scripts/landing-shots/run.sh chat voice   capture only those steps (home chat onboarding voice crops)
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/landing-shots/env.sh
if [ "${1:-}" = "build" ]; then shift; pnpm build; fi
MOCK_PORT=54331 node scripts/landing-shots/demo-mock.mjs > scripts/landing-shots/mock.log 2>&1 & MOCK=$!
pnpm start -p 3100 > scripts/landing-shots/server.log 2>&1 & APP=$!
trap 'kill $MOCK $APP 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -fs -o /dev/null http://localhost:3100/login && break; sleep 0.5; done
node scripts/landing-shots/capture.mjs "$@"
