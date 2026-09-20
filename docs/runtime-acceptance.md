# Real Emacs Runtime Acceptance

`npm run accept:emacs-runtime` validates the MCP-to-Bridge path against a live GNU Emacs instance. It is intentionally separate from mock/fake-Bridge tests.

## Prerequisites

- GNU Emacs 29+ with `emacs-operator-mode` enabled.
- Node.js 22+.
- The MCP process and Emacs must resolve the same `EMACS_OPERATOR_RUNTIME_DIR` when a custom runtime directory is used.

Run:

```bash
EMACS_OPERATOR_ACCEPTANCE_REPORT=dist/acceptance/emacs-runtime.json \
  npm run accept:emacs-runtime
```

Select a particular instance when multiple Emacs processes are publishing records:

```bash
EMACS_OPERATOR_ACCEPTANCE_INSTANCE_ID=<instance-id> \
EMACS_OPERATOR_ACCEPTANCE_REPORT=dist/acceptance/emacs-runtime.json \
  npm run accept:emacs-runtime
```

## Required gates

The runner creates temporary files outside the user's project tree and removes them afterwards. It validates:

1. Live Bridge discovery and token authentication.
2. Background `emacs-lisp-mode` file targeting without a visible window.
3. Exact paged `emacs_read` semantics and continuation metadata.
4. Background semantic `emacs_navigate` search/navigation.
5. Buffer-derived Elisp evaluation with caller source strings disabled.
6. Checkpoint, semantic mutation and atomic rollback.
7. Background `org-mode` targeting.
8. Structured Org table detection and cell mutation through Org APIs.
9. Current-block Org Babel evaluation and result insertion.
10. Default selector resolution to the selected Emacs window buffer.
11. Emacs-internal `C-a` execution through the active keymap with `expected_command` verification.

The acceptance report uses a stable JSON envelope with `pass`, `fail`, `skip`, and `info` gates so another coding agent can consume the result and fix failures.

## Optional package probes

Paredit, smartparens, CIDER and SLY depend on the user's package configuration and live REPL connections. Core runtime acceptance does not fail simply because those optional packages are absent. Use `emacs_capabilities` / `adapter_observe` in the appropriate source buffer to diagnose loaded and connected state.

For final beta acceptance, run additional real workflows with:

- paredit or smartparens structural edits;
- a connected CIDER/nREPL session;
- a connected SLY/Slynk session.
