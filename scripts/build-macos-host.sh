#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-macos-host.sh must run on macOS." >&2
  exit 64
fi
OUT="${1:-$ROOT/dist/macos}"
PACKAGE="$ROOT/apps/macos-host"
APP="$OUT/EmacsOperatorHost.app"
IDENTITY="${EMACS_OPERATOR_CODESIGN_IDENTITY:--}"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swift build --package-path "$PACKAGE" -c release
BIN_DIR="$(swift build --package-path "$PACKAGE" -c release --show-bin-path)"
cp "$BIN_DIR/EmacsOperatorHost" "$APP/Contents/MacOS/EmacsOperatorHost"
cp "$PACKAGE/Resources/Info.plist" "$APP/Contents/Info.plist"
chmod 755 "$APP/Contents/MacOS/EmacsOperatorHost"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --options runtime --sign "$IDENTITY" "$APP"
  codesign --verify --deep --strict "$APP"
fi

echo "Built $APP"
if [[ "$IDENTITY" == "-" ]]; then
  echo "The app is ad-hoc signed. Use EMACS_OPERATOR_CODESIGN_IDENTITY with a stable Developer ID for persistent TCC permissions across releases." >&2
fi
