#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=resolve-emacs.sh
source "$ROOT/scripts/resolve-emacs.sh"
if ! resolve_emacs_bin; then
  echo "GNU Emacs 29+ is required to run ERT tests. Set EMACS_OPERATOR_EMACS_BIN to an executable GNU Emacs when it is not on PATH." >&2
  exit 127
fi

load_args=()
while IFS= read -r -d '' test_file; do
  load_args+=("-l" "$test_file")
done < <(find "$ROOT/lisp/test" -maxdepth 1 -type f -name '*-test.el' -print0 | sort -z)

if [[ "${#load_args[@]}" -eq 0 ]]; then
  echo "No ERT test files were found under $ROOT/lisp/test." >&2
  exit 1
fi

extra_load_args=()
if [[ -n "${EMACS_OPERATOR_LINUX_EMACS_EXTRA_LOAD_PATHS:-}" ]]; then
  IFS=':' read -r -a extra_paths <<<"$EMACS_OPERATOR_LINUX_EMACS_EXTRA_LOAD_PATHS"
  for extra in "${extra_paths[@]}"; do
    [[ -n "$extra" ]] || continue
    [[ -d "$extra" ]] || { echo "Extra Emacs load path is not a directory: $extra" >&2; exit 64; }
    extra_load_args+=("-L" "$extra")
  done
fi

"$EMACS_OPERATOR_RESOLVED_EMACS" -Q --batch \
  -L "$ROOT/lisp" \
  -L "$ROOT/lisp/adapters" \
  -L "$ROOT/lisp/test" \
  "${extra_load_args[@]}" \
  "${load_args[@]}" \
  -f ert-run-tests-batch-and-exit
