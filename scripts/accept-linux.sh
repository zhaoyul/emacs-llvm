#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "accept-linux.sh must run on Linux." >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=resolve-emacs.sh
source "$ROOT/scripts/resolve-emacs.sh"
REPORT_DIR="${EMACS_OPERATOR_LINUX_ACCEPTANCE_REPORT_DIR:-$ROOT/dist/acceptance/linux-$(date -u +%Y%m%dT%H%M%SZ)}"
REQUIRE_EMACS="${EMACS_OPERATOR_LINUX_REQUIRE_EMACS:-0}"
REQUIRE_GUI_EMACS="${EMACS_OPERATOR_LINUX_REQUIRE_GUI_EMACS:-0}"
RUN_BENCHMARKS="${EMACS_OPERATOR_LINUX_RUN_BENCHMARKS:-1}"
if [[ "$REQUIRE_GUI_EMACS" == "1" ]]; then
  REQUIRE_EMACS="1"
fi
mkdir -p "$REPORT_DIR"

CURRENT_STAGE="initialization"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/emacs-operator-linux-acceptance.XXXXXX")"
PIDS=()
EMACS_PID=""
EMACS_ERT_STATUS="not_run"
EMACS_RUNTIME_STATUS="not_run"
WORKFLOW_STATUS="not_run"
REAL_EMACS_NATIVE_STATUS="not_run"
PACKAGE_ACCEPTANCE_STATUS="not_run"
EMACS_REASON="GNU Emacs is unavailable"
DISPLAY_NUMBER=""

kill_owned_processes() {
  set +e
  for ((i=${#PIDS[@]}-1; i>=0; i--)); do
    local pid="${PIDS[$i]}"
    if kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  for _ in {1..20}; do
    local alive=0
    for pid in "${PIDS[@]:-}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    (( alive == 0 )) && break
    sleep 0.1
  done
  for ((i=${#PIDS[@]}-1; i>=0; i--)); do
    local pid="${PIDS[$i]}"
    kill -KILL "$pid" 2>/dev/null || true
  done
}

write_summary() {
  local result="$1" exit_code="$2"
  RESULT="$result" EXIT_CODE="$exit_code" CURRENT_STAGE_VALUE="$CURRENT_STAGE" \
  EMACS_ERT_STATUS_VALUE="$EMACS_ERT_STATUS" EMACS_RUNTIME_STATUS_VALUE="$EMACS_RUNTIME_STATUS" \
  WORKFLOW_STATUS_VALUE="$WORKFLOW_STATUS" REAL_EMACS_NATIVE_STATUS_VALUE="$REAL_EMACS_NATIVE_STATUS" \
  PACKAGE_ACCEPTANCE_STATUS_VALUE="$PACKAGE_ACCEPTANCE_STATUS" \
  EMACS_REASON_VALUE="$EMACS_REASON" DISPLAY_VALUE="${DISPLAY_NUMBER:-}" REPORT_DIR_VALUE="$REPORT_DIR" \
  python3 - <<'PY'
import json, os
from pathlib import Path
report = Path(os.environ["REPORT_DIR_VALUE"])
payload = {
    "schema_version": "1.0",
    "completed_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
    "platform": "linux",
    "result": os.environ["RESULT"],
    "exit_code": int(os.environ["EXIT_CODE"]),
    "failed_stage": None if os.environ["RESULT"] == "pass" else os.environ["CURRENT_STAGE_VALUE"],
    "display": os.environ.get("DISPLAY_VALUE") or None,
    "coverage": {
        "portable": "pass" if os.environ["RESULT"] == "pass" else "see_logs",
        "x11_xtest_synthetic_target": "pass" if (report / "linux-native.json").exists() and json.loads((report / "linux-native.json").read_text()).get("ok") else "not_completed",
        "x11_reliability": "pass" if (report / "linux-reliability.json").exists() and json.loads((report / "linux-reliability.json").read_text()).get("ok") else "not_completed",
        "installed_linux_host": "pass" if (report / "install-smoke.json").exists() and json.loads((report / "install-smoke.json").read_text()).get("ok") else "not_completed",
        "gnu_emacs_ert": os.environ["EMACS_ERT_STATUS_VALUE"],
        "real_emacs_semantic_runtime": os.environ["EMACS_RUNTIME_STATUS_VALUE"],
        "real_emacs_workflows": os.environ["WORKFLOW_STATUS_VALUE"],
        "real_emacs_x11_native": os.environ["REAL_EMACS_NATIVE_STATUS_VALUE"],
        "package_specific_runtime": os.environ["PACKAGE_ACCEPTANCE_STATUS_VALUE"],
        "paredit_runtime": (json.loads((report / "linux-packages.json").read_text()).get("packages", {}).get("paredit", {}).get("status") if (report / "linux-packages.json").exists() else "not_run"),
        "cider_runtime": (json.loads((report / "linux-packages.json").read_text()).get("packages", {}).get("cider", {}).get("status") if (report / "linux-packages.json").exists() else "not_run"),
        "sly_runtime": (json.loads((report / "linux-packages.json").read_text()).get("packages", {}).get("sly", {}).get("status") if (report / "linux-packages.json").exists() else "not_run"),
        "multi_emacs_routing": "pass" if (report / "linux-multi-emacs.json").exists() and json.loads((report / "linux-multi-emacs.json").read_text()).get("ok") else "not_completed",
        "wayland_native": "not_implemented",
        "uinput_native": "not_implemented"
    },
    "emacs_note": os.environ["EMACS_REASON_VALUE"],
    "reports": {
        "preflight": "preflight.log",
        "typescript": "typescript-tests.log",
        "linux_host_tests": "linux-host-tests.log",
        "linux_native": "linux-native.json",
        "linux_native_log": "linux-native.log",
        "linux_reliability": "linux-reliability.json",
        "linux_reliability_log": "linux-reliability.log",
        "install_smoke": "install-smoke.json",
        "install_log": "install-smoke.log",
        "wayland_capability": "wayland-capability.json",
        "uinput_capability": "uinput-capability.json",
        "ert": "ert.log",
        "emacs_runtime": "emacs-runtime.json",
        "workflows": "workflow-acceptance.json",
        "package_runtime": "linux-packages.json",
        "package_runtime_log": "linux-packages.log",
        "real_emacs_native": "linux-real-emacs-native.json",
        "multi_emacs": "linux-multi-emacs.json"
    }
}
(report / "summary.json").write_text(json.dumps(payload, indent=2) + "\n")
PY
}

on_exit() {
  local code=$?
  trap - EXIT
  if [[ "$code" -ne 0 ]]; then write_summary "fail" "$code" || true; fi
  kill_owned_processes
  rm -rf "$TMP_ROOT"
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_logged() {
  local log="$1"; shift
  "$@" 2>&1 | tee "$REPORT_DIR/$log"
}

wait_file() {
  local file="$1" owner_pid="${2:-}" attempts="${3:-100}"
  for _ in $(seq 1 "$attempts"); do
    [[ -s "$file" ]] && return 0
    if [[ -n "$owner_pid" ]] && ! kill -0 "$owner_pid" 2>/dev/null; then return 1; fi
    sleep 0.1
  done
  return 1
}

choose_display() {
  local number
  for number in $(seq 90 199); do
    if [[ ! -S "/tmp/.X11-unix/X$number" && ! -e "/tmp/.X${number}-lock" ]]; then
      printf ':%s\n' "$number"
      return 0
    fi
  done
  return 1
}

cd "$ROOT"
echo "== Emacs Operator Linux acceptance =="
echo "Reports: $REPORT_DIR"

CURRENT_STAGE="linux_preflight"
run_logged preflight.log bash ./scripts/linux-preflight.sh

CURRENT_STAGE="version_consistency"
run_logged version.log npm run check:version

CURRENT_STAGE="elisp_structure"
run_logged elisp-structure.log npm run check:elisp-structure

CURRENT_STAGE="typescript_tests"
run_logged typescript-tests.log npm run test:ts

CURRENT_STAGE="agent_experiment_tests"
run_logged agent-experiment-tests.log npm run test:agent-experiment

if [[ "$RUN_BENCHMARKS" == "1" ]]; then
  CURRENT_STAGE="benchmark_corpus_validation"
  run_logged benchmark-corpus.log npm run benchmark:validate
fi

CURRENT_STAGE="linux_host_unit_tests"
run_logged linux-host-tests.log node --test apps/linux-host/test/*.test.mjs

CURRENT_STAGE="linux_host_native_build"
run_logged linux-host-build.log make -C apps/linux-host clean all

CURRENT_STAGE="xvfb_start"
DISPLAY_NUMBER="$(choose_display)"
export DISPLAY="$DISPLAY_NUMBER"
XVFB_NETWORK_ARGS=(-nolisten tcp)
if [[ "${EMACS_OPERATOR_LINUX_XVFB_TCP:-0}" == "1" ]]; then
  # Some isolated/chroot test runtimes cannot see the host X11 UNIX socket.
  # Enable TCP only when explicitly requested by the acceptance environment.
  XVFB_NETWORK_ARGS=(-listen tcp)
fi
Xvfb "$DISPLAY" -screen 0 1280x800x24 "${XVFB_NETWORK_ARGS[@]}" >"$REPORT_DIR/xvfb.log" 2>&1 &
PIDS+=("$!")
for _ in {1..100}; do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
xdpyinfo >/dev/null 2>&1 || { echo "Xvfb did not become ready on $DISPLAY." >&2; exit 1; }

CURRENT_STAGE="x11_probe_start"
PREVIOUS_READY="$TMP_ROOT/previous.json"
PREVIOUS_LOG="$REPORT_DIR/x11-previous-events.jsonl"
TARGET_READY="$TMP_ROOT/target.json"
TARGET_LOG="$REPORT_DIR/x11-target-events.jsonl"
apps/linux-host/build/x11-probe --title "Emacs Operator Previous Probe" --log "$PREVIOUS_LOG" --ready "$PREVIOUS_READY" >"$REPORT_DIR/previous-probe.log" 2>&1 &
PIDS+=("$!")
PREVIOUS_PID_PROCESS="$!"
apps/linux-host/build/x11-probe --title "Emacs Operator Target Probe" --log "$TARGET_LOG" --ready "$TARGET_READY" >"$REPORT_DIR/target-probe.log" 2>&1 &
PIDS+=("$!")
TARGET_PID_PROCESS="$!"
wait_file "$PREVIOUS_READY" "$PREVIOUS_PID_PROCESS" || { echo "Previous X11 probe did not become ready." >&2; exit 1; }
wait_file "$TARGET_READY" "$TARGET_PID_PROCESS" || { echo "Target X11 probe did not become ready." >&2; exit 1; }

PREVIOUS_PID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$PREVIOUS_READY")"
PREVIOUS_WINDOW="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_identifier"])' "$PREVIOUS_READY")"
apps/linux-host/build/x11-helper focus --pid "$PREVIOUS_PID" --window-id "$PREVIOUS_WINDOW" --timeout-ms 2000 >"$REPORT_DIR/initial-focus.json"

CURRENT_STAGE="linux_host_install_smoke"
INSTALL_PREFIX="$TMP_ROOT/install-prefix"
INSTALL_RUNTIME="$TMP_ROOT/install-driver"
INSTALL_CAPTURE="$TMP_ROOT/install-captures"
EMACS_OPERATOR_LINUX_PREFIX="$INSTALL_PREFIX" bash ./scripts/install-linux-host.sh >"$REPORT_DIR/install-smoke.log" 2>&1
[[ -x "$INSTALL_PREFIX/bin/emacs-operator-linux-host" ]] || { echo "Installed Linux Host launcher is missing." >&2; exit 1; }
[[ -x "$INSTALL_PREFIX/lib/emacs-operator-linux-host/build/x11-helper" ]] || { echo "Installed X11 helper is missing." >&2; exit 1; }
EMACS_OPERATOR_DRIVER_RUNTIME_DIR="$INSTALL_RUNTIME" EMACS_OPERATOR_CAPTURE_DIR="$INSTALL_CAPTURE" \
  EMACS_OPERATOR_LINUX_BACKEND="x11" "$INSTALL_PREFIX/bin/emacs-operator-linux-host" \
  >"$REPORT_DIR/install-host.stdout.log" 2>"$REPORT_DIR/install-host.stderr.log" &
PIDS+=("$!")
INSTALL_HOST_PID="$!"
wait_file "$INSTALL_RUNTIME/driver.json" "$INSTALL_HOST_PID" || { echo "Installed Linux Host did not publish driver.json." >&2; exit 1; }
EMACS_OPERATOR_DRIVER_RUNTIME_DIR="$INSTALL_RUNTIME" node --input-type=module - <<'NODE' >"$REPORT_DIR/install-smoke.json"
import { AutoPlatformDriver } from "./dist/packages/mcp-server/src/drivers/platformDriver.js";
const driver = new AutoPlatformDriver();
try {
  const capabilities = await driver.initialize();
  if (!capabilities.connected || capabilities.backend !== "x11_xtest" || capabilities.native_keyboard !== true) {
    throw new Error(`Installed Linux Host capability check failed: ${JSON.stringify(capabilities)}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, capabilities }, null, 2)}\n`);
} finally {
  driver.close();
}
NODE
kill -TERM "$INSTALL_HOST_PID" 2>/dev/null || true
wait "$INSTALL_HOST_PID" 2>/dev/null || true
EMACS_OPERATOR_LINUX_PREFIX="$INSTALL_PREFIX" bash ./scripts/uninstall-linux-host.sh >>"$REPORT_DIR/install-smoke.log" 2>&1
[[ ! -e "$INSTALL_PREFIX/bin/emacs-operator-linux-host" && ! -e "$INSTALL_PREFIX/lib/emacs-operator-linux-host" ]] || { echo "Linux Host uninstall smoke left installed files behind." >&2; exit 1; }

CURRENT_STAGE="linux_host_start"
export EMACS_OPERATOR_DRIVER_RUNTIME_DIR="$TMP_ROOT/driver"
export EMACS_OPERATOR_CAPTURE_DIR="$TMP_ROOT/captures"
export EMACS_OPERATOR_LINUX_BACKEND="x11"
node apps/linux-host/src/host.mjs >"$REPORT_DIR/linux-host.stdout.log" 2>"$REPORT_DIR/linux-host.stderr.log" &
PIDS+=("$!")
LINUX_HOST_PID="$!"
wait_file "$EMACS_OPERATOR_DRIVER_RUNTIME_DIR/driver.json" "$LINUX_HOST_PID" || { echo "Linux Host did not publish driver.json." >&2; exit 1; }

CURRENT_STAGE="linux_native_acceptance"
export EMACS_OPERATOR_LINUX_TARGET_READY="$TARGET_READY"
export EMACS_OPERATOR_LINUX_PREVIOUS_READY="$PREVIOUS_READY"
export EMACS_OPERATOR_LINUX_TARGET_LOG="$TARGET_LOG"
export EMACS_OPERATOR_LINUX_PREVIOUS_LOG="$PREVIOUS_LOG"
EMACS_OPERATOR_LINUX_NATIVE_REPORT="$REPORT_DIR/linux-native.json" \
  run_logged linux-native.log npm run accept:linux-native

CURRENT_STAGE="linux_reliability_acceptance"
EMACS_OPERATOR_LINUX_RELIABILITY_REPORT="$REPORT_DIR/linux-reliability.json" \
  run_logged linux-reliability.log npm run accept:linux-reliability

CURRENT_STAGE="wayland_capability_honesty"
env -u DISPLAY WAYLAND_DISPLAY="wayland-acceptance" EMACS_OPERATOR_LINUX_BACKEND="auto" \
  EMACS_OPERATOR_DRIVER_RUNTIME_DIR="$TMP_ROOT/wayland-driver" \
  node --input-type=module - <<'NODE' >"$REPORT_DIR/wayland-capability.json"
import { createLinuxBackend } from "./apps/linux-host/src/x11-backend.mjs";
const backend = await createLinuxBackend({ runtimeDirectory: process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR });
const capabilities = await backend.capabilities();
if (capabilities.backend !== "unavailable" || capabilities.native_keyboard !== false || capabilities.display_server !== "wayland") {
  throw new Error(`Wayland capability negotiation was not conservative: ${JSON.stringify(capabilities)}`);
}
process.stdout.write(`${JSON.stringify({ ok: true, capabilities }, null, 2)}\n`);
NODE

CURRENT_STAGE="uinput_capability_report"
python3 - <<'PY' >"$REPORT_DIR/uinput-capability.json"
import json, os
paths = ["/dev/uinput", "/dev/input/uinput"]
available = [p for p in paths if os.path.exists(p)]
writable = [p for p in paths if os.access(p, os.W_OK)]
print(json.dumps({
    "ok": True,
    "implemented": False,
    "available_paths": available,
    "writable_paths": writable,
    "note": "Alpha.13 reserves uinput for a later backend. uinput alone does not provide target-window focus or capture."
}, indent=2))
PY

if resolve_emacs_bin; then
  EMACS_REASON="GNU Emacs is installed; ERT was required. GUI/runtime coverage depends on the build."
  CURRENT_STAGE="emacs_ert"
  run_logged ert.log npm run test:elisp
  EMACS_ERT_STATUS="pass"

  CURRENT_STAGE="graphical_emacs_start"
  EMACS_RUNTIME_DIR="$TMP_ROOT/emacs-runtime"
  mkdir -p "$EMACS_RUNTIME_DIR"
  chmod 700 "$EMACS_RUNTIME_DIR"
  export EMACS_OPERATOR_RUNTIME_DIR="$EMACS_RUNTIME_DIR"
  EMACS_PACKAGE_ARGS=()
  if [[ -n "${EMACS_OPERATOR_LINUX_EMACS_EXTRA_LOAD_PATHS:-}" ]]; then
    IFS=':' read -r -a extra_paths <<<"$EMACS_OPERATOR_LINUX_EMACS_EXTRA_LOAD_PATHS"
    for extra in "${extra_paths[@]}"; do
      [[ -n "$extra" ]] || continue
      [[ -d "$extra" ]] || { echo "Extra Emacs load path is not a directory: $extra" >&2; exit 64; }
      EMACS_PACKAGE_ARGS+=("-L" "$extra")
    done
  fi
  if [[ -n "${EMACS_OPERATOR_LINUX_EMACS_SETUP_FILE:-}" ]]; then
    [[ -f "$EMACS_OPERATOR_LINUX_EMACS_SETUP_FILE" && ! -L "$EMACS_OPERATOR_LINUX_EMACS_SETUP_FILE" ]] || { echo "Emacs package setup file must be a regular non-symlink file." >&2; exit 64; }
    EMACS_PACKAGE_ARGS+=("-l" "$EMACS_OPERATOR_LINUX_EMACS_SETUP_FILE")
  fi
  "$EMACS_OPERATOR_RESOLVED_EMACS" -Q --display "$DISPLAY" \
    -L "$ROOT/lisp" -L "$ROOT/lisp/adapters" -l emacs-operator "${EMACS_PACKAGE_ARGS[@]}" \
    --eval '(progn (setq frame-title-format "Emacs Operator Linux Acceptance") (set-frame-parameter nil (quote title) "Emacs Operator Linux Acceptance") (switch-to-buffer (get-buffer-create "*Emacs Operator Linux Native Acceptance*")) (erase-buffer) (emacs-lisp-mode) (insert "ABCDE\n") (goto-char 4) (emacs-operator-mode 1) (redisplay t))' \
    >"$REPORT_DIR/dedicated-emacs.log" 2>&1 &
  PIDS+=("$!")
  EMACS_PID="$!"

  BRIDGE_RECORD=""
  for _ in {1..120}; do
    records=("$EMACS_RUNTIME_DIR"/instance-*.json)
    if [[ -f "${records[0]}" ]]; then BRIDGE_RECORD="${records[0]}"; break; fi
    kill -0 "$EMACS_PID" 2>/dev/null || break
    sleep 0.1
  done

  if [[ -n "$BRIDGE_RECORD" ]]; then
    CURRENT_STAGE="real_emacs_runtime_acceptance"
    EMACS_OPERATOR_ACCEPTANCE_REPORT="$REPORT_DIR/emacs-runtime.json" \
      run_logged emacs-runtime.log npm run accept:emacs-runtime
    EMACS_RUNTIME_STATUS="pass"

    CURRENT_STAGE="real_emacs_workflow_acceptance"
    EMACS_OPERATOR_WORKFLOW_ACCEPTANCE_REPORT="$REPORT_DIR/workflow-acceptance.json" \
      run_logged workflow-acceptance.log npm run accept:workflows
    WORKFLOW_STATUS="pass"

    CURRENT_STAGE="package_specific_runtime_acceptance"
    EMACS_OPERATOR_LINUX_PACKAGE_INSTANCE_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["instance_id"])' "$BRIDGE_RECORD")" \
    EMACS_OPERATOR_LINUX_PACKAGE_ACCEPTANCE_REPORT="$REPORT_DIR/linux-packages.json" \
      run_logged linux-packages.log npm run accept:linux-packages
    PACKAGE_ACCEPTANCE_STATUS="pass"

    CURRENT_STAGE="real_emacs_previous_focus"
    apps/linux-host/build/x11-helper focus --pid "$PREVIOUS_PID" --window-id "$PREVIOUS_WINDOW" --timeout-ms 2000 >"$REPORT_DIR/pre-real-emacs-focus.json"

    CURRENT_STAGE="real_emacs_native_acceptance"
    EMACS_OPERATOR_LINUX_EMACS_NATIVE_REPORT="$REPORT_DIR/linux-real-emacs-native.json" \
      run_logged linux-real-emacs-native.log npm run accept:linux-emacs-native
    REAL_EMACS_NATIVE_STATUS="pass"

    CURRENT_STAGE="secondary_graphical_emacs_start"
    SECONDARY_EMACS_BUFFER="*Emacs Operator Linux Secondary Acceptance*"
    "$EMACS_OPERATOR_RESOLVED_EMACS" -Q --display "$DISPLAY" \
      -L "$ROOT/lisp" -L "$ROOT/lisp/adapters" -l emacs-operator \
      --eval '(progn (setq frame-title-format "Emacs Operator Linux Secondary") (set-frame-parameter nil (quote title) "Emacs Operator Linux Secondary") (switch-to-buffer (get-buffer-create "*Emacs Operator Linux Secondary Acceptance*")) (erase-buffer) (emacs-lisp-mode) (insert "ALPHA14-SECONDARY\n") (goto-char (point-max)) (emacs-operator-mode 1) (redisplay t))' \
      >"$REPORT_DIR/secondary-emacs.log" 2>&1 &
    PIDS+=("$!")
    SECONDARY_EMACS_PID="$!"
    for _ in {1..120}; do
      LIVE_COUNT="$(python3 - "$EMACS_RUNTIME_DIR" <<'PYCOUNT'
import json, os, sys
root=sys.argv[1]
count=0
for name in os.listdir(root):
    if not name.startswith('instance-') or not name.endswith('.json'): continue
    try:
        value=json.load(open(os.path.join(root,name)))
        os.kill(int(value.get('pid',0)),0)
        count += 1
    except Exception:
        pass
print(count)
PYCOUNT
)"
      [[ "$LIVE_COUNT" -ge 2 ]] && break
      kill -0 "$SECONDARY_EMACS_PID" 2>/dev/null || break
      sleep 0.1
    done
    if [[ "${LIVE_COUNT:-0}" -lt 2 ]]; then
      echo "Secondary GNU Emacs did not publish a second live bridge instance." >&2
      exit 1
    fi

    CURRENT_STAGE="multi_emacs_routing_acceptance"
    EMACS_OPERATOR_LINUX_PRIMARY_EMACS_PID="$EMACS_PID" \
    EMACS_OPERATOR_LINUX_SECONDARY_EMACS_PID="$SECONDARY_EMACS_PID" \
    EMACS_OPERATOR_LINUX_PRIMARY_EMACS_BUFFER="*Emacs Operator Linux Native Acceptance*" \
    EMACS_OPERATOR_LINUX_SECONDARY_EMACS_BUFFER="$SECONDARY_EMACS_BUFFER" \
    EMACS_OPERATOR_LINUX_PRIMARY_EMACS_MARKER="你XABCDE" \
    EMACS_OPERATOR_LINUX_SECONDARY_EMACS_MARKER="ALPHA14-SECONDARY" \
    EMACS_OPERATOR_LINUX_MULTI_EMACS_REPORT="$REPORT_DIR/linux-multi-emacs.json" \
      run_logged linux-multi-emacs.log npm run accept:linux-multi-emacs

    EMACS_REASON="GNU Emacs ERT, semantic runtime, workflows, X11 native interaction, reliability, and multi-instance routing passed."
  else
    EMACS_RUNTIME_STATUS="not_run"
    WORKFLOW_STATUS="not_run"
    REAL_EMACS_NATIVE_STATUS="not_run"
PACKAGE_ACCEPTANCE_STATUS="not_run"
    EMACS_REASON="GNU Emacs is installed, but this binary did not publish a graphical Emacs Operator bridge under Xvfb. See dedicated-emacs.log."
    if [[ "$REQUIRE_GUI_EMACS" == "1" ]]; then
      echo "$EMACS_REASON" >&2
      exit 1
    fi
  fi
else
  if [[ "$REQUIRE_EMACS" == "1" ]]; then
    CURRENT_STAGE="emacs_required"
    EMACS_REASON="GNU Emacs is required by the Linux acceptance policy but is unavailable."
    echo "$EMACS_REASON" >&2
    exit 1
  fi
  : >"$REPORT_DIR/ert.log"
fi

CURRENT_STAGE="finalize"
write_summary "pass" 0
trap - EXIT
kill_owned_processes
rm -rf "$TMP_ROOT"

echo "PASS: Linux X11/XTest acceptance"
echo "Report directory: $REPORT_DIR"
echo "Real Emacs coverage: ERT=$EMACS_ERT_STATUS runtime=$EMACS_RUNTIME_STATUS workflows=$WORKFLOW_STATUS packages=$PACKAGE_ACCEPTANCE_STATUS native=$REAL_EMACS_NATIVE_STATUS"
