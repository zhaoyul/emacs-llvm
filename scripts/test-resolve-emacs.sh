#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
# shellcheck source=resolve-emacs.sh
source "$ROOT/scripts/resolve-emacs.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

make_fake() {
  local path="$1" major="$2"
  mkdir -p "$(dirname "$path")"
  cat >"$path" <<SCRIPT
#!/usr/bin/env bash
if [[ "\${*:-}" == *"emacs-major-version"* ]]; then printf '%s' "$major"; exit 0; fi
printf 'fake emacs %s\\n' "$major"
SCRIPT
  chmod 0755 "$path"
}

make_fake "$TMP/good" 30
make_fake "$TMP/old" 28

EMACS_OPERATOR_EMACS_BIN="$TMP/good" resolve_emacs_bin
[[ "$EMACS_OPERATOR_RESOLVED_EMACS" == "$TMP/good" ]]
[[ "$EMACS_OPERATOR_RESOLVED_EMACS_MAJOR" == 30 ]]

set +e
EMACS_OPERATOR_EMACS_BIN="$TMP/old" resolve_emacs_bin >/dev/null 2>&1
rc=$?
set -e
[[ $rc -eq 127 ]]

unset EMACS_OPERATOR_EMACS_BIN EMACS_OPERATOR_RESOLVED_EMACS EMACS_OPERATOR_RESOLVED_EMACS_MAJOR
mkdir -p "$TMP/runtime/bin"
make_fake "$TMP/runtime/bin/emacs" 31
EMACS_OPERATOR_EMACS_RUNTIME_ROOT="$TMP/runtime" resolve_emacs_bin
[[ "$EMACS_OPERATOR_RESOLVED_EMACS" == "$TMP/runtime/bin/emacs" ]]
[[ "$EMACS_OPERATOR_RESOLVED_EMACS_MAJOR" == 31 ]]

printf 'resolve-emacs tests PASS\n'
