#!/usr/bin/env bash
set -euo pipefail
PREFIX="${EMACS_OPERATOR_LINUX_PREFIX:-$HOME/.local}"
if [[ "$PREFIX" == "$HOME/.local" ]]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now emacs-operator-linux-host.service >/dev/null 2>&1 || true
  fi
  rm -f "$HOME/.config/systemd/user/emacs-operator-linux-host.service"
fi
rm -f "$PREFIX/bin/emacs-operator-linux-host"
rm -rf "$PREFIX/lib/emacs-operator-linux-host"
if command -v systemctl >/dev/null 2>&1; then systemctl --user daemon-reload >/dev/null 2>&1 || true; fi
echo "Removed Emacs Operator Linux Host from $PREFIX."
