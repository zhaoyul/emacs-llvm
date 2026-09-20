#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install-macos-host.sh must run on macOS." >&2
  exit 64
fi
DEST_ROOT="${1:-$HOME/Applications}"
BUILD_ROOT="$(mktemp -d)"
trap 'rm -rf "$BUILD_ROOT"' EXIT
bash "$ROOT/scripts/build-macos-host.sh" "$BUILD_ROOT"
mkdir -p "$DEST_ROOT"
rm -rf "$DEST_ROOT/EmacsOperatorHost.app"
cp -R "$BUILD_ROOT/EmacsOperatorHost.app" "$DEST_ROOT/EmacsOperatorHost.app"
echo "Installed $DEST_ROOT/EmacsOperatorHost.app"
echo "Start it with: open '$DEST_ROOT/EmacsOperatorHost.app'"
echo "Then grant Accessibility. Grant Screen Recording only if emacs_capture is needed."
