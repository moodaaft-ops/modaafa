#!/usr/bin/env bash
# Stops what up.sh/app.sh started and deletes the throwaway database and keys.
# Docker objects: removes ONLY containers and networks that carry the local-stack label.
# Host processes: stops only the pids recorded in .local-stack, and only if the pid still runs the
# expected command.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$ROOT/.local-stack"
# shellcheck disable=SC1091
. "$HERE/versions.env"

for entry in "app:next" "gateway:gateway.mjs" "llm-stub:llm-stub.mjs"; do
  node "$HERE/proc.mjs" stop "$STATE/${entry%%:*}.pid" "${entry##*:}" || true
done

status=0
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  containers="$(docker ps -aq --filter "label=$LS_LABEL")"
  [ -n "$containers" ] && docker rm -f $containers >/dev/null 2>&1
  networks="$(docker network ls -q --filter "label=$LS_LABEL")"
  [ -n "$networks" ] && docker network rm $networks >/dev/null 2>&1
  left="$(docker ps -aq --filter "label=$LS_LABEL"; docker network ls -q --filter "label=$LS_LABEL")"
  if [ -n "$left" ]; then echo "Some labelled Docker objects are still there; run down.sh again." >&2; status=1; fi
else
  echo "Docker is not reachable, so containers were not touched." >&2
  status=1
fi
rm -rf "$STATE"
[ "$status" = 0 ] && echo "Local stack removed."
exit $status
