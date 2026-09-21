#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "accept-linux-x11-inner must run on Linux." >&2
  exit 64
fi
if [[ -z "${DISPLAY:-}" ]]; then
  echo "DISPLAY is required. Run this script through accept-linux-x11.sh." >&2
  exit 64
fi

WORK="${EMACS_OPERATOR_LINUX_ACCEPTANCE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/emacs-operator-linux-x11.XXXXXX")}" 
mkdir -p "$WORK"
chmod 700 "$WORK"
KEEP="${EMACS_OPERATOR_KEEP_ACCEPTANCE_ARTIFACTS:-0}"
PIDS=()
cleanup() {
  local status=$?
  set +e
  for (( index=${#PIDS[@]}-1; index>=0; index-- )); do
    kill "${PIDS[$index]}" 2>/dev/null || true
  done
  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  if [[ "$KEEP" != "1" && -z "${EMACS_OPERATOR_LINUX_ACCEPTANCE_DIR:-}" ]]; then
    rm -rf "$WORK"
  elif [[ "$status" -ne 0 || "$KEEP" == "1" ]]; then
    echo "Linux X11 acceptance artifacts: $WORK" >&2
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

wait_for_file() {
  local file=$1
  local timeout_seconds=${2:-10}
  local deadline=$((SECONDS + timeout_seconds))
  while [[ ! -s "$file" ]]; do
    if (( SECONDS >= deadline )); then
      echo "Timed out waiting for $file" >&2
      return 1
    fi
    sleep 0.05
  done
}

HELPER="$ROOT/apps/linux-host/build/x11-helper"
PROBE="$ROOT/apps/linux-host/build/x11-probe"
if [[ ! -x "$HELPER" || ! -x "$PROBE" ]]; then
  make -C "$ROOT/apps/linux-host" all
fi

TARGET_READY="$WORK/target-ready.json"
TARGET_EVENTS="$WORK/target-events.jsonl"
TARGET_COMMAND="$WORK/target-command.txt"
COMPANION_READY="$WORK/companion-ready.json"
COMPANION_EVENTS="$WORK/companion-events.jsonl"
DRIVER_RUNTIME="$WORK/driver-runtime"
CAPTURE_RUNTIME="$WORK/captures"
REPORT="${EMACS_OPERATOR_LINUX_SYNTHETIC_REPORT:-$WORK/linux-x11-synthetic.json}"
HOST_LOG="$WORK/linux-host.log"

"$PROBE" \
  --title "Linux Synthetic GNU Emacs" \
  --log "$TARGET_EVENTS" \
  --ready "$TARGET_READY" \
  --command-file "$TARGET_COMMAND" &
PIDS+=("$!")
wait_for_file "$TARGET_READY"

"$PROBE" \
  --title "Linux Synthetic Companion" \
  --log "$COMPANION_EVENTS" \
  --ready "$COMPANION_READY" &
PIDS+=("$!")
wait_for_file "$COMPANION_READY"

read_json_field() {
  local file=$1
  local field=$2
  node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const x=v[process.argv[2]]; if(x===undefined||x===null) process.exit(2); process.stdout.write(String(x));' "$file" "$field"
}

TARGET_PID="$(read_json_field "$TARGET_READY" pid)"
TARGET_WINDOW="$(read_json_field "$TARGET_READY" window_identifier)"
COMPANION_PID="$(read_json_field "$COMPANION_READY" pid)"
COMPANION_WINDOW="$(read_json_field "$COMPANION_READY" window_identifier)"

# Establish a known precondition: a non-target window is frontmost before the
# native sequence. The acceptance later verifies that this window is restored.
"$HELPER" focus \
  --pid "$COMPANION_PID" \
  --window-id "$COMPANION_WINDOW" \
  --timeout-ms 2000 >/dev/null

mkdir -p "$DRIVER_RUNTIME" "$CAPTURE_RUNTIME"
chmod 700 "$DRIVER_RUNTIME" "$CAPTURE_RUNTIME"
EMACS_OPERATOR_DRIVER_RUNTIME_DIR="$DRIVER_RUNTIME" \
EMACS_OPERATOR_CAPTURE_DIR="$CAPTURE_RUNTIME" \
EMACS_OPERATOR_LINUX_BACKEND=x11 \
node "$ROOT/apps/linux-host/src/host.mjs" >"$HOST_LOG" 2>&1 &
PIDS+=("$!")
wait_for_file "$DRIVER_RUNTIME/driver.json"

export EMACS_OPERATOR_DRIVER_RUNTIME_DIR="$DRIVER_RUNTIME"
export EMACS_OPERATOR_CAPTURE_DIR="$CAPTURE_RUNTIME"
export EMACS_OPERATOR_LINUX_TARGET_PID="$TARGET_PID"
export EMACS_OPERATOR_LINUX_TARGET_WINDOW_ID="$TARGET_WINDOW"
export EMACS_OPERATOR_LINUX_OTHER_PID="$COMPANION_PID"
export EMACS_OPERATOR_LINUX_COMMAND_FILE="$TARGET_COMMAND"
export EMACS_OPERATOR_LINUX_EVENT_FILE="$TARGET_EVENTS"
export EMACS_OPERATOR_LINUX_SYNTHETIC_REPORT="$REPORT"

node "$ROOT/dist/packages/mcp-server/src/linuxSyntheticAcceptance.js"

node -e '
const fs=require("fs");
const report=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(report?.summary?.ok!==true) {
  console.error(JSON.stringify(report,null,2));
  process.exit(1);
}
' "$REPORT"

echo "Linux X11 synthetic acceptance passed: $REPORT"
