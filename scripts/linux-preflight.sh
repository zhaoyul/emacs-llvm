#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: linux-preflight.sh must run on Linux." >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=resolve-emacs.sh
source "$ROOT/scripts/resolve-emacs.sh"
MODE="${EMACS_OPERATOR_LINUX_PREFLIGHT_MODE:-acceptance}"
if [[ "$MODE" != "acceptance" && "$MODE" != "build" && "$MODE" != "runtime" ]]; then
  echo "ERROR: EMACS_OPERATOR_LINUX_PREFLIGHT_MODE must be acceptance, build, or runtime." >&2
  exit 64
fi
failures=0
warn() { printf 'WARN: %s\n' "$*" >&2; }
pass() { printf 'PASS: %s\n' "$*"; }
info() { printf 'INFO: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }

required_commands=(node)
if [[ "$MODE" == "acceptance" ]]; then
  required_commands+=(npm python3 make cc Xvfb xdpyinfo)
elif [[ "$MODE" == "build" ]]; then
  required_commands+=(make cc)
fi
for command in "${required_commands[@]}"; do
  if command -v "$command" >/dev/null 2>&1; then
    pass "$command is available: $(command -v "$command")"
  else
    if [[ "$MODE" == "acceptance" ]]; then
      fail "$command is required for the Linux acceptance harness."
    elif [[ "$MODE" == "build" ]]; then
      fail "$command is required to build the Linux Host."
    else
      fail "$command is required to run the Linux Host."
    fi
  fi
done

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( node_major >= 22 )); then
    pass "Node.js is >= 22 ($(node --version))."
  else
    fail "Node.js 22+ is required; found $(node --version)."
  fi
fi

if [[ "$MODE" != "runtime" ]]; then
  for header in /usr/include/X11/Xlib.h /usr/include/png.h; do
    if [[ -f "$header" ]]; then pass "development header exists: $header"; else fail "missing development header: $header"; fi
  done
fi

ldconfig_output="$(ldconfig -p 2>/dev/null || true)"
if grep -q 'libX11\.so' <<<"$ldconfig_output"; then pass "libX11 runtime is available."; else fail "libX11 runtime is unavailable."; fi
if grep -q 'libXtst\.so\.6' <<<"$ldconfig_output"; then pass "libXtst runtime is available."; else fail "libXtst.so.6 runtime is unavailable."; fi
if grep -q 'libpng' <<<"$ldconfig_output"; then pass "libpng runtime is available."; else fail "libpng runtime is unavailable."; fi

if resolve_emacs_bin; then
  pass "GNU Emacs is available: $EMACS_OPERATOR_RESOLVED_EMACS"
  "$EMACS_OPERATOR_RESOLVED_EMACS" --version | head -1 | sed 's/^/INFO: /'
else
  warn "GNU Emacs is unavailable. X11/XTest native acceptance can still run, but ERT and real-Emacs gates will be marked not_run. Set EMACS_OPERATOR_EMACS_BIN for a portable/cached Emacs."
fi

if [[ -w /dev/uinput || -w /dev/input/uinput ]]; then
  info "A writable uinput device is present. The current Linux backend uses X11/XTest because uinput alone cannot select or capture a target window."
else
  info "No writable /dev/uinput device is present. This does not block the X11/XTest backend."
fi

if [[ -n "${WAYLAND_DISPLAY:-}" && -z "${DISPLAY:-}" ]]; then
  warn "A Wayland-only session is detected. The Linux backend intentionally reports native desktop automation unavailable there; semantic/internal_keys remain supported."
elif [[ -n "${WAYLAND_DISPLAY:-}" && -n "${DISPLAY:-}" ]]; then
  info "Wayland with XWayland is detected. The X11 backend can target X11/XWayland Emacs windows only."
elif [[ -n "${DISPLAY:-}" ]]; then
  info "An X11 display is already set: $DISPLAY"
else
  if [[ "$MODE" == "acceptance" ]]; then
    info "No DISPLAY is set. The acceptance runner will launch a private Xvfb display."
  else
    info "No DISPLAY is set. Installation can continue, but the X11 backend needs DISPLAY when the host starts."
  fi
fi

if [[ "$MODE" == "runtime" ]]; then
  info "Runtime mode validates shared libraries only; use build mode for compiler/header checks."
elif [[ -x "$ROOT/apps/linux-host/build/x11-helper" ]]; then
  pass "Linux X11 helper is already built."
else
  if [[ "$MODE" == "acceptance" ]]; then
    info "Linux X11 helper will be built by the acceptance runner."
  else
    info "Linux X11 helper will be built by the installer."
  fi
fi

if (( failures > 0 )); then
  printf '\nLinux preflight finished with %d hard failure(s).\n' "$failures" >&2
  exit 1
fi
if [[ "$MODE" == "acceptance" ]]; then
  printf '\nLinux X11 acceptance prerequisites passed. Optional runtime warnings are reported above.\n'
elif [[ "$MODE" == "build" ]]; then
  printf '\nLinux Host build prerequisites passed. Optional desktop-session warnings are reported above.\n'
else
  printf '\nLinux Host runtime prerequisites passed. Optional desktop-session warnings are reported above.\n'
fi
