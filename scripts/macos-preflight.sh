#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: macos-preflight.sh must run on macOS." >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UID_NUM="$(id -u)"
BRIDGE_RUNTIME="${EMACS_OPERATOR_RUNTIME_DIR:-${TMPDIR:-/tmp}/emacs-operator-${UID_NUM}}"
DRIVER_RUNTIME="${EMACS_OPERATOR_DRIVER_RUNTIME_DIR:-${TMPDIR:-/tmp}/emacs-operator-driver-${UID_NUM}}"
HOST_APP="${EMACS_OPERATOR_HOST_APP:-$HOME/Applications/EmacsOperatorHost.app}"

failures=0
warn() { printf 'WARN: %s\n' "$*" >&2; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }

for command in node npm swift plutil codesign; do
  if command -v "$command" >/dev/null 2>&1; then
    pass "$command is available: $(command -v "$command")"
  else
    fail "$command is not on PATH."
  fi
done

# shellcheck source=resolve-emacs.sh
source "$ROOT/scripts/resolve-emacs.sh"
if EMACS_OPERATOR_REQUIRE_GUI_EMACS=1 resolve_emacs_bin; then
  pass "Graphical GNU Emacs ${EMACS_OPERATOR_RESOLVED_EMACS_MAJOR} is available: $EMACS_OPERATOR_RESOLVED_EMACS"
elif resolve_emacs_bin; then
  fail "Only a terminal-only GNU Emacs was found ($EMACS_OPERATOR_RESOLVED_EMACS); native acceptance needs a graphical build such as /Applications/Emacs.app (set EMACS_OPERATOR_EMACS_BIN)."
else
  fail "GNU Emacs 29+ was not found on PATH or in a standard Emacs.app location (set EMACS_OPERATOR_EMACS_BIN)."
fi

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( node_major >= 22 )); then pass "Node.js is >= 22 ($(node --version))."; else fail "Node.js 22+ is required."; fi
fi

if [[ -d "$HOST_APP" ]]; then
  pass "Host app exists: $HOST_APP"
  if codesign --verify --deep --strict "$HOST_APP" >/dev/null 2>&1; then
    pass "Host app code signature verifies."
  else
    fail "Host app code signature verification failed."
  fi
  if plutil -lint "$HOST_APP/Contents/Info.plist" >/dev/null 2>&1; then
    pass "Host app Info.plist is valid."
  else
    fail "Host app Info.plist is invalid or missing."
  fi
else
  warn "Host app is not installed at $HOST_APP. Run scripts/install-macos-host.sh."
fi

check_private_file() {
  local path="$1" label="$2"
  if [[ ! -f "$path" ]]; then return 1; fi
  local mode
  mode="$(stat -f '%Lp' "$path")"
  if (( (8#$mode & 8#077) == 0 )); then
    pass "$label has private permissions ($mode): $path"
  else
    fail "$label permissions are too broad ($mode): $path"
  fi
}

if [[ -f "$DRIVER_RUNTIME/driver.json" ]]; then
  pass "Native host runtime record exists: $DRIVER_RUNTIME/driver.json"
  check_private_file "$DRIVER_RUNTIME/driver.json" "driver.json" || true
  token_file="$(python3 - "$DRIVER_RUNTIME/driver.json" <<'PY' 2>/dev/null || true
import json,sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    print(json.load(f).get('token_file',''))
PY
)"
  if [[ -n "$token_file" && -f "$token_file" ]]; then
    check_private_file "$token_file" "driver token" || true
  else
    fail "Driver token file referenced by driver.json is missing."
  fi
else
  warn "Native host is not currently publishing $DRIVER_RUNTIME/driver.json. Launch EmacsOperatorHost.app to test native_keys/capture."
fi

shopt -s nullglob
bridge_records=("$BRIDGE_RUNTIME"/instance-*.json)
if (( ${#bridge_records[@]} > 0 )); then
  pass "Found ${#bridge_records[@]} Emacs bridge instance record(s) in $BRIDGE_RUNTIME."
  for record in "${bridge_records[@]}"; do
    check_private_file "$record" "Emacs instance record" || true
  done
else
  warn "No live Emacs bridge instance record found in $BRIDGE_RUNTIME. Start Emacs with emacs-operator-mode enabled."
fi
shopt -u nullglob

if [[ -x "$ROOT/scripts/build-macos-host.sh" ]]; then
  pass "Repository macOS build/install scripts are present."
fi

printf '\nRuntime paths:\n  Emacs bridge: %s\n  Native host:  %s\n  Host app:     %s\n' "$BRIDGE_RUNTIME" "$DRIVER_RUNTIME" "$HOST_APP"

if (( failures > 0 )); then
  printf '\nPreflight finished with %d hard failure(s).\n' "$failures" >&2
  exit 1
fi
printf '\nPreflight hard checks passed. Warnings above indicate optional runtime components that are not currently running.\n'
