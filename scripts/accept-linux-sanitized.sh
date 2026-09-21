#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "accept-linux-sanitized.sh must run on Linux." >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT_DIR="${EMACS_OPERATOR_LINUX_SANITIZER_REPORT_DIR:-$ROOT/dist/acceptance/linux-sanitized-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$REPORT_DIR"
chmod 700 "$REPORT_DIR"

for command in cc make node npm xvfb-run xauth; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required sanitizer acceptance command is missing: $command" >&2; exit 69; }
done

restore_release_build() {
  set +e
  make -C "$ROOT/apps/linux-host" clean all >"$REPORT_DIR/release-rebuild.log" 2>&1
}
trap restore_release_build EXIT

cd "$ROOT"
npm run build >"$REPORT_DIR/typescript-build.log" 2>&1
make -C apps/linux-host clean all \
  CFLAGS='-std=c11 -O1 -g -Wall -Wextra -Wpedantic -fsanitize=address,undefined -fno-omit-frame-pointer' \
  LDFLAGS='-fsanitize=address,undefined' \
  >"$REPORT_DIR/sanitizer-build.log" 2>&1

export ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=0:abort_on_error=1}"
export UBSAN_OPTIONS="${UBSAN_OPTIONS:-halt_on_error=1:print_stacktrace=1}"
export EMACS_OPERATOR_KEEP_ACCEPTANCE_ARTIFACTS=1
export EMACS_OPERATOR_LINUX_ACCEPTANCE_DIR="$REPORT_DIR/x11"
export EMACS_OPERATOR_LINUX_SYNTHETIC_REPORT="$REPORT_DIR/x11/linux-x11-synthetic.json"

XSERVER_ARGS="${EMACS_OPERATOR_XVFB_ARGS:--screen 0 1280x960x24 -ac -nolisten tcp}"
xvfb-run -a -s "$XSERVER_ARGS" bash "$ROOT/scripts/accept-linux-x11-inner.sh" \
  >"$REPORT_DIR/sanitizer-acceptance.log" 2>&1

python3 - "$REPORT_DIR" <<'PY'
import json, pathlib, sys
report_dir = pathlib.Path(sys.argv[1])
source = report_dir / "x11" / "linux-x11-synthetic.json"
data = json.loads(source.read_text())
if data.get("summary", {}).get("ok") is not True:
    raise SystemExit("sanitized X11 acceptance did not pass")
summary = {
    "schema_version": "1.0",
    "platform": "linux",
    "sanitizers": ["address", "undefined"],
    "leak_detection": "disabled because Xlib/libpng process teardown is not the memory-safety target",
    "ok": True,
    "acceptance_report": "x11/linux-x11-synthetic.json"
}
(report_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
PY

echo "PASS: Linux X11 helper under ASan/UBSan"
echo "Report directory: $REPORT_DIR"
