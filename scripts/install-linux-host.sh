#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "install-linux-host.sh must run on Linux." >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${EMACS_OPERATOR_LINUX_PREFIX:-$HOME/.local}"
LIB_DIR="$PREFIX/lib/emacs-operator-linux-host"
BIN_DIR="$PREFIX/bin"
INSTALL_SYSTEMD="${EMACS_OPERATOR_INSTALL_SYSTEMD_USER:-0}"

if [[ "$INSTALL_SYSTEMD" != "0" && "$INSTALL_SYSTEMD" != "1" ]]; then
  echo "EMACS_OPERATOR_INSTALL_SYSTEMD_USER must be 0 or 1." >&2
  exit 64
fi
if [[ "$INSTALL_SYSTEMD" == "1" && "$PREFIX" != "$HOME/.local" ]]; then
  echo "Systemd user installation currently requires EMACS_OPERATOR_LINUX_PREFIX=$HOME/.local." >&2
  exit 64
fi
if [[ "$INSTALL_SYSTEMD" == "1" ]] && ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required when EMACS_OPERATOR_INSTALL_SYSTEMD_USER=1." >&2
  exit 69
fi

cd "$ROOT"
EMACS_OPERATOR_LINUX_PREFLIGHT_MODE=build bash ./scripts/linux-preflight.sh
make -C apps/linux-host clean all

rm -rf "$LIB_DIR"
mkdir -p "$LIB_DIR/src" "$LIB_DIR/build" "$BIN_DIR"
chmod 755 "$PREFIX" "$PREFIX/lib" "$LIB_DIR" "$LIB_DIR/src" "$LIB_DIR/build" "$BIN_DIR" 2>/dev/null || true
cp apps/linux-host/src/*.mjs "$LIB_DIR/src/"
cp apps/linux-host/build/x11-helper "$LIB_DIR/build/"
chmod 755 "$LIB_DIR/build/x11-helper"

cat > "$BIN_DIR/emacs-operator-linux-host" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "$LIB_DIR/src/host.mjs" "\$@"
EOF
chmod 755 "$BIN_DIR/emacs-operator-linux-host"

if [[ "$INSTALL_SYSTEMD" == "1" ]]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cp "$ROOT/packaging/systemd/emacs-operator-linux-host.service" "$UNIT_DIR/"
  systemctl --user daemon-reload
  systemctl --user enable --now emacs-operator-linux-host.service
  echo "Installed and started systemd user service."
fi

echo "Installed Linux Host: $BIN_DIR/emacs-operator-linux-host"
echo "Backend selection: EMACS_OPERATOR_LINUX_BACKEND=auto|x11"
