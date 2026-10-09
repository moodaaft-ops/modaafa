#!/usr/bin/env bash
# Stops everything started by up.sh/app.sh and deletes the throwaway database and keys.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$ROOT/.local-stack"
for name in app gateway llm-stub; do
  if [ -f "$STATE/$name.pid" ]; then
    pid="$(cat "$STATE/$name.pid")"
    # setsid made the pid a process-group leader; stop the whole group.
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  fi
done
docker rm -f ls-rest ls-auth ls-postgres >/dev/null 2>&1 || true
rm -rf "$STATE"
echo "Local stack removed."
