#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="${EMACS_OPERATOR_RUNTIME_DIR:-$(mktemp -d)}"
export EMACS_OPERATOR_RUNTIME_DIR="$RUNTIME"
exec emacs -Q --eval "(progn (add-to-list 'load-path \"$ROOT/lisp\") (add-to-list 'load-path \"$ROOT/lisp/adapters\") (require 'emacs-operator) (emacs-operator-mode 1))"
