# STATUS

## Current release

`0.1.0-alpha.16`

## Executive status

Alpha.16 keeps Linux as the authoritative development platform and focuses on reproducible acceptance. The shared MCP/Bridge runtime, semantic/internal-key layers, Linux X11/XTEST native driver, reliability controls, package-runtime contracts, refactoring/workflow layer, and packaging remain implemented.

The current session no longer contains the cached GNU Emacs runtime used by earlier Linux acceptance. Alpha.16 therefore adds a private, locked runtime bootstrap instead of pretending that dependency is present.

| Area | Current alpha.16 evidence |
| --- | --- |
| Version / protocol metadata | PASS |
| TypeScript shared runtime | PASS, 93/93 |
| Agent experiment wrapper | PASS, 18/18 |
| Refactor intelligence | PASS, 29/29 |
| Linux Host unit tests | PASS, 11/11 |
| Swift portable tests | PASS, 5/5 |
| Emacs resolver | PASS |
| Private Debian-runtime provisioner | PASS, 3/3 |
| Locked Git source acquisition | PASS, 3/3 |
| Linux X11/XTEST native acceptance | PASS |
| Linux reliability | PASS, 8/8 |
| Linux Host install/uninstall smoke | PASS |
| Full hard Linux gate (REQUIRE_EMACS, GUI, PAREDIT, CIDER, SLY) | PASS on GNU Emacs 29.3 / Xvfb |
| GNU Emacs ERT on current alpha.16 tree | PASS, 78/78 on GNU Emacs 29.3 with pinned package load paths (77 + paredit skip without them) |
| Paredit runtime | PASS, real `paredit-mode` binding through `internal_keys` |
| CIDER/nREPL runtime | PASS, CIDER 2.0.1 + cider-nrepl 0.62.2 on Clojure 1.12.5 |
| SLY/Slynk runtime | PASS, pinned SLY + Slynk on SBCL 2.2.9 |
| Wayland native backend | NOT_IMPLEMENTED |
| macOS local native acceptance | IN PROGRESS: first real-Mac run passed preflight/TypeScript, stopped at ERT (bash 3.2, fixed); rerun pending |

## 2026-09-22 real-runtime session

GNU Emacs 29.3 was provisioned and the alpha.16 tree was accepted against real runtimes for the first time. Running CIDER and SLY for real exposed adapter defects that stubs had hidden; all are fixed with regression tests (`lisp/test/emacs-operator-repl-adapters-test.el`, 8 tests that fail on the previous adapters):

- `eval_defun` evaluated the *previous* top-level form when point was at a defun start (where `beginning_of_defun` leaves it), for both CIDER and SLY.
- CIDER adapter: `cider-nrepl-sync-request:eval` arguments were swapped (namespace passed as connection); nREPL `nrepl-dict` replies were read with `assoc`, so value/err/ex/status were always nil; `namespace-not-found`/`eval-error` statuses were reported as success. The adapter now reads nrepl-dicts, treats error statuses as structured failures and, like CIDER's `cider-auto-track-ns-form-changes`, evaluates the buffer's own `ns` form once when the namespace is not loaded (recorded as `ns_form_evaluated`).
- SLY adapter: relied on a nonexistent `sly-eval-and-grab-output`, stringified Slynk's `(stdout values)` reply, and let Lisp errors enter the interactive debugger until timeout. Requests now run inside Lisp-side `handler-case`, return plain values, and report conditions structurally.

Reproducible package runtime: `sources.lock.json` now pins CIDER's full Emacs dependency closure; `jvm.lock.json` pins Clojure 1.12.5 + nREPL 1.7.0 + cider-nrepl 0.62.2 and its closure by SHA-256; `npm run runtime:packages:start` acquires, verifies and starts nREPL/Slynk and writes an env file for `accept:linux`. The manual `Linux Package Runtime` workflow uses it (it previously could not pass: `npm ci` without a lockfile and apt packages Ubuntu 24.04 does not ship).

macOS: `accept-macos.sh`/preflight now resolve GNU Emacs from `Emacs.app` bundles; `run-ert.sh` works under macOS `/bin/bash` 3.2; stage logs capture stderr; `scripts/run-macos-acceptance-local.sh` runs the whole local flow.

Known non-gating issue: the dedicated GTK Emacs sometimes segfaults while being terminated at the end of `accept:linux` (after all gates have reported).

Earlier alpha.14 evidence demonstrated the same core runtime with GNU Emacs 30.2, including ERT, semantic/internal-key workflows, real Emacs XTEST/capture, and multi-Emacs routing. Alpha.16 does not reuse that historical evidence as if ERT had been rerun on the new tree.

## Alpha.16 changes

- Acceptance scripts invoke subordinate shell scripts with `bash`, so ZIP/tar permission metadata loss does not become an orchestration failure.
- `resolve-emacs.sh` validates actual GNU Emacs major version and discovers project-private runtimes.
- `provision-emacs-runtime.mjs` locks local Debian packages by SHA-256 plus package/version/architecture, extracts to private staging, probes GNU Emacs, and atomically activates a runtime.
- `acquire-git-source.mjs` fetches only exact full commits, verifies checkout identity, rejects special files, and writes per-file provenance manifests.
- `sources.lock.json` pins Paredit, CIDER, and SLY source identities and records CIDER/SLY runtime dependencies.
- CIDER/SLY package acceptance generates fresh function/namespace identities per run to avoid long-lived REPL contamination.
- `accept:alpha16` supports segmented Linux evidence reuse after validating the Linux summary and required native/reliability/install coverage.

## Hard acceptance

With a private or system GNU Emacs 29+ available:

```bash
EMACS_OPERATOR_ALPHA16_REQUIRE_REAL_EMACS=1 npm run accept:alpha16

EMACS_OPERATOR_LINUX_REQUIRE_EMACS=1 \
EMACS_OPERATOR_LINUX_REQUIRE_GUI_EMACS=1 \
npm run accept:linux
```

With real package ecosystems installed and connected:

```bash
EMACS_OPERATOR_LINUX_REQUIRE_PAREDIT=1 \
EMACS_OPERATOR_LINUX_REQUIRE_CIDER=1 \
EMACS_OPERATOR_LINUX_REQUIRE_SLY=1 \
npm run accept:linux
```

See `docs/linux-private-emacs-runtime.md` and `docs/linux-package-acceptance.md`.
