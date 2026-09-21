#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "accept-linux-x11 must run on Linux." >&2
  exit 64
fi

for command in node npm make cc xvfb-run xauth; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 69
  fi
done

make -C "$ROOT/apps/linux-host" clean all
npm --prefix "$ROOT" run build

XSERVER_ARGS="${EMACS_OPERATOR_XVFB_ARGS:--screen 0 1280x960x24 -ac -nolisten tcp}"
exec xvfb-run -a -s "$XSERVER_ARGS" bash "$ROOT/scripts/accept-linux-x11-inner.sh"
