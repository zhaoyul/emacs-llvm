# Emacs Operator

Emacs Operator exposes GNU Emacs as a stateful runtime for LLM agents. It combines structured semantic operations, Emacs-internal key events, and guarded OS-native input instead of treating Emacs as only a text file editor.

Current version: `0.1.0-alpha.16`.

## Execution channels

- `semantic`: bounded reads, deterministic navigation, exact edits, registered commands, Lisp/Org adapters, structured evaluation, validation, refactoring, checkpoints and guarded workflows.
- `internal_keys`: real Emacs command-loop input via `execute-kbd-macro`, resolved through the active major/minor-mode keymaps. This is the preferred channel when paredit, org-mode, transient maps, minibuffers, or user bindings are part of the semantics.
- `native_keys`: OS-level keyboard injection for desktop-behavior verification. Linux uses X11/XTEST; macOS source uses Accessibility + CGEvent.

The default rule is: prefer semantic operations for deterministic intent, use `internal_keys` when Emacs keymap/interactive behavior matters, and reserve `native_keys` for actual desktop input verification.

## Alpha.16 status

Linux remains the authoritative implementation platform. Alpha.16 makes acceptance reproducible when GNU Emacs is not preinstalled: it can resolve a private runtime, lock and provision a local Debian package set, and acquire Paredit/CIDER/SLY source trees at exact pinned commits.

Current alpha.16 evidence (GNU Emacs 29.3, Xvfb, 2026-09-22):

- TypeScript: 93/93 PASS; agent experiment, refactor intelligence, Linux Host, resolver, provisioner and source/JVM acquisition tests PASS;
- GNU Emacs ERT: 78/78 PASS (paredit case included when the pinned package load path is present);
- hard `accept:linux` with `REQUIRE_EMACS`, `REQUIRE_GUI_EMACS`, `REQUIRE_PAREDIT`, `REQUIRE_CIDER`, `REQUIRE_SLY`: PASS — semantic runtime, workflows, X11/XTEST real-Emacs input, reliability 8/8, multi-Emacs routing, and all three package gates;
- macOS: in progress on a real Mac (see STATUS.md).

The release gate supports segmented evidence so a separately completed `accept:linux` report can be reused without rerunning a long desktop suite. See `docs/linux-private-emacs-runtime.md`.

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

## Important live-runtime fix

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

## Reproducible package runtime

```bash
npm run runtime:packages:start          # pinned sources + SHA-256-pinned JVM jars, starts nREPL/Slynk on loopback
set -a; . .runtime/package-runtime/package-runtime.env; set +a
EMACS_OPERATOR_LINUX_REQUIRE_EMACS=1 EMACS_OPERATOR_LINUX_REQUIRE_GUI_EMACS=1 \
EMACS_OPERATOR_LINUX_REQUIRE_PAREDIT=1 EMACS_OPERATOR_LINUX_REQUIRE_CIDER=1 EMACS_OPERATOR_LINUX_REQUIRE_SLY=1 \
npm run accept:linux
npm run runtime:packages:stop
```

Requires `git`, `node` 22+, a JRE (17+) and `sbcl`. The same flow runs in the manual `Linux Package Runtime` GitHub workflow.

## Remaining acceptance work

- macOS: rerun `bash scripts/run-macos-acceptance-local.sh` on a real Mac (Accessibility, CGEvent, ScreenCaptureKit, foreground restoration, Emacs/package workflows). The first run stopped at ERT because of a macOS `/bin/bash` 3.2 incompatibility, now fixed.
- Wayland native input remains unimplemented by design.
