#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "accept-macos.sh must run on macOS." >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT_DIR="${EMACS_OPERATOR_ACCEPTANCE_REPORT_DIR:-$ROOT/dist/acceptance/$(date -u +%Y%m%dT%H%M%SZ)}"
USE_EXISTING="${EMACS_OPERATOR_ACCEPTANCE_USE_EXISTING:-0}"
mkdir -p "$REPORT_DIR"

owned_emacs_pid=""
owned_runtime=""
CURRENT_STAGE="initialization"

cleanup() {
  if [[ -n "$owned_emacs_pid" ]] && kill -0 "$owned_emacs_pid" 2>/dev/null; then
    kill -TERM "$owned_emacs_pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$owned_emacs_pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$owned_emacs_pid" 2>/dev/null; then
      kill -KILL "$owned_emacs_pid" 2>/dev/null || true
    fi
  fi
  if [[ -n "$owned_runtime" ]]; then
    rm -rf "$owned_runtime"
  fi
}

write_failure_summary() {
  local code="$1"
  if [[ ! -f "$REPORT_DIR/summary.json" ]]; then
    cat > "$REPORT_DIR/summary.json" <<JSON
{
  "schema_version": "1.0",
  "completed_at": "$(date -u +%FT%TZ)",
  "result": "fail",
  "exit_code": $code,
  "failed_stage": "$CURRENT_STAGE",
  "reports": {
    "emacs_runtime": "emacs-runtime.json",
    "workflows": "workflow-acceptance.json",
    "native": "macos-native.json",
    "benchmark_corpus_log": "benchmark-corpus.log",
    "benchmark_sensitivity": "benchmark-sensitivity/experiment.json",
    "ert_log": "ert.log",
    "typescript_log": "typescript-tests.log",
    "swift_log": "swift-tests.log"
  }
}
JSON
  fi
}

on_exit() {
  local code=$?
  trap - EXIT
  if [[ "$code" -ne 0 ]]; then
    write_failure_summary "$code"
  fi
  cleanup
  exit "$code"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$ROOT"
# shellcheck source=resolve-emacs.sh
source "$ROOT/scripts/resolve-emacs.sh"
if ! resolve_emacs_bin; then
  echo "GNU Emacs 29+ was not found. Set EMACS_OPERATOR_EMACS_BIN or install Emacs.app." >&2
  exit 127
fi
export EMACS_OPERATOR_EMACS_BIN="$EMACS_OPERATOR_RESOLVED_EMACS"
echo "== Emacs Operator macOS acceptance =="
echo "Emacs: $EMACS_OPERATOR_RESOLVED_EMACS (major $EMACS_OPERATOR_RESOLVED_EMACS_MAJOR)"
echo "Reports: $REPORT_DIR"

CURRENT_STAGE="macos_preflight"
bash ./scripts/macos-preflight.sh | tee "$REPORT_DIR/preflight.log"

CURRENT_STAGE="version_consistency"
npm run check:version | tee "$REPORT_DIR/version.log"

CURRENT_STAGE="elisp_structure"
npm run check:elisp-structure | tee "$REPORT_DIR/elisp-structure.log"

CURRENT_STAGE="typescript_tests"
npm run test:ts | tee "$REPORT_DIR/typescript-tests.log"

CURRENT_STAGE="benchmark_corpus_validation"
npm run benchmark:validate | tee "$REPORT_DIR/benchmark-corpus.log"

CURRENT_STAGE="benchmark_harness_sensitivity"
EMACS_OPERATOR_BENCHMARK_SENSITIVITY_DIR="$REPORT_DIR/benchmark-sensitivity" \
  npm run benchmark:sensitivity | tee "$REPORT_DIR/benchmark-sensitivity.log"

CURRENT_STAGE="emacs_ert"
npm run test:elisp | tee "$REPORT_DIR/ert.log"

CURRENT_STAGE="swift_tests"
(
  cd apps/macos-host
  swift test
) | tee "$REPORT_DIR/swift-tests.log"

CURRENT_STAGE="emacs_runtime_start"
if [[ "$USE_EXISTING" != "1" ]]; then
  owned_runtime="$(mktemp -d "${TMPDIR:-/tmp}/emacs-operator-acceptance.XXXXXX")"
  export EMACS_OPERATOR_RUNTIME_DIR="$owned_runtime"
  echo "Starting dedicated graphical Emacs acceptance instance in $owned_runtime"
  "$EMACS_OPERATOR_RESOLVED_EMACS" -Q \
    -L "$ROOT/lisp" \
    -L "$ROOT/lisp/adapters" \
    -l emacs-operator \
    --eval '(progn (switch-to-buffer (get-buffer-create "*Emacs Operator Acceptance*")) (erase-buffer) (emacs-lisp-mode) (insert "(message \"Emacs Operator acceptance\")\n") (goto-char (point-max)) (emacs-operator-mode 1))' \
    >"$REPORT_DIR/dedicated-emacs.log" 2>&1 &
  owned_emacs_pid="$!"

  found=0
  for _ in {1..100}; do
    records=("$owned_runtime"/instance-*.json)
    if [[ -f "${records[0]}" ]]; then
      found=1
      break
    fi
    if ! kill -0 "$owned_emacs_pid" 2>/dev/null; then
      echo "Dedicated Emacs exited before publishing a bridge record. See $REPORT_DIR/dedicated-emacs.log" >&2
      exit 1
    fi
    sleep 0.1
  done
  if [[ "$found" != "1" ]]; then
    echo "Timed out waiting for dedicated Emacs bridge record." >&2
    exit 1
  fi
else
  echo "Using existing Emacs Operator instance(s)."
fi

CURRENT_STAGE="emacs_runtime_acceptance"
EMACS_OPERATOR_ACCEPTANCE_REPORT="$REPORT_DIR/emacs-runtime.json" \
  npm run accept:emacs-runtime | tee "$REPORT_DIR/emacs-runtime.log"

# Native acceptance intentionally runs after semantic/internal acceptance. It
# requires EmacsOperatorHost.app to already have Accessibility and Screen
# Recording permission. First-run TCC prompts cannot be safely auto-approved.
CURRENT_STAGE="workflow_acceptance"
EMACS_OPERATOR_WORKFLOW_ACCEPTANCE_REPORT="$REPORT_DIR/workflow-acceptance.json" \
  npm run accept:workflows | tee "$REPORT_DIR/workflow-acceptance.log"

CURRENT_STAGE="macos_native_acceptance"
EMACS_OPERATOR_NATIVE_ACCEPTANCE_REPORT="$REPORT_DIR/macos-native.json" \
  npm run accept:macos-native | tee "$REPORT_DIR/macos-native.log"

CURRENT_STAGE="finalize"
cat > "$REPORT_DIR/summary.json" <<JSON
{
  "schema_version": "1.0",
  "completed_at": "$(date -u +%FT%TZ)",
  "result": "pass",
  "reports": {
    "emacs_runtime": "emacs-runtime.json",
    "workflows": "workflow-acceptance.json",
    "native": "macos-native.json",
    "native_log": "macos-native.log",
    "benchmark_corpus_log": "benchmark-corpus.log",
    "benchmark_sensitivity": "benchmark-sensitivity/experiment.json",
    "benchmark_sensitivity_log": "benchmark-sensitivity.log",
    "ert_log": "ert.log",
    "typescript_log": "typescript-tests.log",
    "swift_log": "swift-tests.log"
  }
}
JSON

echo "PASS: full macOS acceptance"
echo "Report directory: $REPORT_DIR"
