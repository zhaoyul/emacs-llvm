#!/usr/bin/env bash
# Stop runtimes started by start-package-runtimes.sh.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNTIME_DIR="${1:-$ROOT/.runtime/package-runtime}"
for name in nrepl slynk; do
  pid_file="$RUNTIME_DIR/$name.pid"
  [[ -f "$pid_file" ]] || continue
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
  echo "stopped $name"
done
