# Emacs Operator

Emacs Operator exposes GNU Emacs as a stateful runtime for LLM agents. It combines structured semantic operations, Emacs-internal key events, and guarded OS-native input instead of treating Emacs as only a text file editor.

Current version: `0.1.0-alpha.14`.

## Execution channels

- `semantic`: bounded reads, deterministic navigation, exact edits, registered commands, Lisp/Org adapters, structured evaluation, validation, refactoring, checkpoints and guarded workflows.
- `internal_keys`: real Emacs command-loop input via `execute-kbd-macro`, resolved through the active major/minor-mode keymaps. This is the preferred channel when paredit, org-mode, transient maps, minibuffers, or user bindings are part of the semantics.
- `native_keys`: OS-level keyboard injection for desktop-behavior verification. Linux uses X11/XTEST; macOS source uses Accessibility + CGEvent.

The default rule is: prefer semantic operations for deterministic intent, use `internal_keys` when Emacs keymap/interactive behavior matters, and reserve `native_keys` for actual desktop input verification.

## Alpha.14 status

The Linux hard gate also covers two simultaneous real Emacs GUI instances. Stale-record cleanup is isolation-aware: if `/proc` is hidden and `process-attributes` cannot verify a peer PID, the bridge probes that PID with signal 0 before deleting its token/instance record.

Linux is the current authoritative acceptance platform.
The current alpha.14 full Linux hard gate completes with exit code 0 and a unified PASS summary.

Verified on GNU Emacs 30.2 under Linux/Xvfb:

- ERT: 63 PASS, 0 FAIL, 1 conditional paredit test skipped because paredit is not installed in the acceptance runtime;
- live Bridge discovery and authenticated loopback RPC;
- exact `emacs_read`, background `emacs_navigate`, structured Elisp evaluation and validation;
- checkpoint/rollback and runtime-condition repair loops;
- Org heading/table/Babel construction, execution and structural validation;
- high-level Lisp/Org workflows, including repeatable `extract_function` acceptance in a long-lived Emacs runtime;
- internal-key command verification;
- Linux X11/XTEST native input, Unicode delivery, focus restoration, private PNG capture, cancellation and multi-instance routing.

Alpha.14 adds an explicit package-specific runtime gate:

```bash
npm run accept:linux-packages
```

It reports each of `paredit`, `cider`, and `sly` as `pass`, `not_run`, or `fail`. A package capability probe is never counted as runtime acceptance.

Current acceptance environment status:

- paredit: `not_run`, package not installed/autoloaded;
- CIDER: `not_run`, package/nREPL runtime unavailable;
- SLY: `not_run`, package/Slynk runtime unavailable.

Use hard requirements in CI when those ecosystems are installed:

```bash
EMACS_OPERATOR_LINUX_REQUIRE_PAREDIT=1 \
EMACS_OPERATOR_LINUX_REQUIRE_CIDER=1 \
EMACS_OPERATOR_LINUX_REQUIRE_SLY=1 \
npm run accept:linux
```

Missing required package/runtime coverage then fails the Linux gate.

## Package-specific acceptance

A dedicated acceptance Emacs can receive extra package load paths and a trusted local setup file:

```bash
EMACS_OPERATOR_LINUX_EMACS_EXTRA_LOAD_PATHS=/opt/elisp/paredit:/opt/elisp/cider:/opt/elisp/sly \
EMACS_OPERATOR_LINUX_EMACS_SETUP_FILE=/opt/emacs-operator/package-acceptance.el \
EMACS_OPERATOR_LINUX_PACKAGE_WAIT_MS=30000 \
npm run accept:linux
```

The setup file may load packages and establish local nREPL/Slynk connections. The acceptance runner itself does not fake either runtime.

Package gates exercise actual behavior:

- paredit: enable the real minor mode, resolve the current binding for `paredit-forward-slurp-sexp`, execute that binding through `internal_keys`, verify `last-command`, structural result, and balanced delimiters;
- CIDER: evaluate a buffer-derived definition, verify value `42`, capture a structured runtime error, edit the same source target, and pass a guarded verification-ticket rerun;
- SLY: the same definition/value/error/repair/rerun contract through SLY/Slynk.

See `docs/linux-package-acceptance.md`.

## Important alpha.14 fix

`extract_function` can optionally load both the generated helper and its enclosing definition before behavior verification. This is necessary in a live Lisp runtime: loading only the helper leaves the old enclosing function definition resident even though the buffer text has changed. The workflow acceptance now uses unique per-run generated function names, so repeated acceptance in the same long-lived Emacs does not create false name-collision failures.

## Main commands

```bash
npm run check:version
npm run check:elisp-structure
npm run test:ts
npm run test:elisp
npm run accept:emacs-runtime
npm run accept:workflows
npm run accept:linux-packages
npm run accept:linux
npm run accept:macos
```

For Linux hard acceptance with GNU Emacs GUI coverage:

```bash
EMACS_OPERATOR_LINUX_REQUIRE_EMACS=1 \
EMACS_OPERATOR_LINUX_REQUIRE_GUI_EMACS=1 \
npm run accept:linux
```

## Architecture

```text
LLM Agent
   |
   v
MCP Server / policy / sessions / audit
   |
   +----------------+--------------------+
   |                |                    |
semantic       internal_keys         native_keys
   |                |                    |
Lisp/Org       Emacs command loop     Platform Host
adapters       active keymaps          |
   |                |              Linux XTEST
   |                |              macOS CGEvent
   +-------- GNU Emacs runtime ----------+
```

## Remaining acceptance work

Linux core runtime is accepted. The remaining package-specific gates require real external dependencies rather than mocks:

- paredit package installation;
- CIDER + Clojure + live nREPL;
- SLY + Common Lisp implementation + live Slynk.

After those Linux gates are available, the same source tree can be exercised on the user's Mac with `npm run accept:macos` for Accessibility, CGEvent, ScreenCaptureKit, foreground restoration, and the same Emacs/package workflows.
