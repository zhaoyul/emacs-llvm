#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/.emacs.d/site-lisp/emacs-operator}"
mkdir -p "$DEST/adapters"
cp "$ROOT"/lisp/*.el "$DEST/"
cp "$ROOT"/lisp/adapters/*.el "$DEST/adapters/"
echo "Installed Emacs Operator Lisp files to $DEST"
echo "Add this to init.el:"
echo "  (add-to-list 'load-path \"$DEST\")"
echo "  (add-to-list 'load-path \"$DEST/adapters\")"
echo "  (require 'emacs-operator)"
echo "  (emacs-operator-mode 1)"
