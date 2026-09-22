#!/usr/bin/env bash
# One-shot local macOS acceptance for Emacs Operator.
#
# Usage (from Terminal, on the Mac):
#   bash run-macos-acceptance-local.sh
#
# Run it from a folder that contains either an `emacs-llvm/` checkout or an
# `emacs-llvm.bundle` git bundle. Reports are copied to ./reports-latest/ next
# to this script so a remote agent can read them without rerunning anything.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$HERE/emacs-llvm"
BRANCH="${EMACS_OPERATOR_ACCEPT_BRANCH:-claude/linux-real-runtime-progress}"
HOST_APP="$HOME/Applications/EmacsOperatorHost.app"
CONSOLE_LOG="$HERE/acceptance-console.log"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "This script must run on macOS."

say "Checking prerequisites"
command -v git   >/dev/null || die "git missing: run 'xcode-select --install'."
command -v swift >/dev/null || die "Swift missing: run 'xcode-select --install' (or install Xcode)."
if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 22 )); then
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.nvm/nvm.sh"
    nvm use 22 >/dev/null 2>&1 || nvm install 22 || die "Could not activate Node 22 with nvm."
  fi
fi
command -v node >/dev/null || die "Node.js 22+ missing (brew install node@22, or nvm install 22)."
(( $(node -p 'process.versions.node.split(".")[0]') >= 22 )) || die "Node.js 22+ required, found $(node --version)."
echo "git:   $(command -v git)"
echo "swift: $(swift --version 2>/dev/null | head -1)"
echo "node:  $(node --version)"

say "Preparing source checkout ($BRANCH)"
if [[ ! -d "$REPO/.git" ]]; then
  if [[ -f "$HERE/emacs-llvm.bundle" ]]; then
    git clone -q -b "$BRANCH" "$HERE/emacs-llvm.bundle" "$REPO" || die "git clone from bundle failed."
  else
    git clone -q https://github.com/zhaoyul/emacs-llvm "$REPO" || die "git clone failed."
  fi
fi
# An existing checkout is used as-is (it may carry newer local commits than the bundle).
cd "$REPO"
echo "HEAD:  $(git log --oneline -1)"

say "Resolving graphical GNU Emacs 29+"
# shellcheck source=/dev/null
ROOT="$REPO"
source scripts/resolve-emacs.sh
EMACS_OPERATOR_REQUIRE_GUI_EMACS=1 resolve_emacs_bin \
  || die "No graphical GNU Emacs 29+ found (terminal-only builds are skipped). Install Emacs.app or set EMACS_OPERATOR_EMACS_BIN."
echo "emacs: $EMACS_OPERATOR_RESOLVED_EMACS (major $EMACS_OPERATOR_RESOLVED_EMACS_MAJOR)"
export EMACS_OPERATOR_EMACS_BIN="$EMACS_OPERATOR_RESOLVED_EMACS"

say "Installing TypeScript toolchain (no lockfile, no install scripts)"
npm install --no-save --package-lock=false --ignore-scripts typescript@5.9.2 >/dev/null || die "npm install failed."

say "Building and installing EmacsOperatorHost.app"
bash scripts/install-macos-host.sh || die "Host build/install failed (see output above)."
open "$HOST_APP" || die "Could not launch $HOST_APP"

cat <<EOF

--------------------------------------------------------------------------
ACTION NEEDED (one time; macOS does not allow this to be automated):

  System Settings > Privacy & Security > Accessibility
      -> enable "EmacsOperatorHost"
  System Settings > Privacy & Security > Screen Recording
      -> enable "EmacsOperatorHost"

If macOS asks to quit & reopen the Host, allow it.
--------------------------------------------------------------------------
EOF
read -r -p "Press Enter once both permissions are granted... " _
# Restart the host so it picks up freshly granted TCC permissions.
pkill -x EmacsOperatorHost 2>/dev/null || true
sleep 1
open "$HOST_APP"
sleep 2

say "Running npm run accept:macos (Terminal should stay frontmost)"
npm run accept:macos 2>&1 | tee "$CONSOLE_LOG"
status=${PIPESTATUS[0]}

latest="$(ls -1dt "$REPO"/dist/acceptance/*/ 2>/dev/null | head -1)"
if [[ -n "$latest" ]]; then
  mkdir -p "$HERE/reports-latest"
  cp -R "$latest"/. "$HERE/reports-latest/"
  cp "$CONSOLE_LOG" "$HERE/reports-latest/"
  echo "Reports copied to: $HERE/reports-latest"
fi
if [[ "$status" == "0" ]]; then
  say "PASS: macOS acceptance"
else
  printf '\n\033[31mFAIL: accept:macos exited %s. See reports-latest/summary.json\033[0m\n' "$status"
fi
exit "$status"
