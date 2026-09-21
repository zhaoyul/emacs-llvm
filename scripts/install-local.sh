#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELISP_DEST="${EMACS_OPERATOR_ELISP_DEST:-$HOME/.emacs.d/site-lisp/emacs-operator}"
cd "$ROOT"
npm run build
bash "$ROOT/scripts/install-elisp-package.sh" "$ELISP_DEST"
if [[ "$(uname -s)" == "Darwin" && "${EMACS_OPERATOR_SKIP_MACOS_HOST:-0}" != "1" ]]; then
  bash "$ROOT/scripts/install-macos-host.sh"
fi
cat <<MSG

MCP command:
  node $ROOT/dist/packages/mcp-server/src/server.js

Recommended init.el:
  (add-to-list 'load-path "$ELISP_DEST")
  (add-to-list 'load-path "$ELISP_DEST/adapters")
  (require 'emacs-operator)
  (emacs-operator-mode 1)

Run emacs_instances from the MCP client after restarting Emacs.
MSG
