# Implementation Report, alpha.16

## Objective

Make Linux acceptance reproducible even when the execution environment loses the GNU Emacs binary, package-manager cache, or shell executable bits between sessions.

## Implemented

1. Shell orchestration hardening: subordinate `.sh` scripts are invoked explicitly through `bash`.
2. GNU Emacs resolver: explicit binary, runtime root, project-private runtime and PATH discovery with a real `emacs-major-version >= 29` probe.
3. Private Debian runtime provisioner: SHA-256 lock, Debian control metadata verification, private staging extraction, real Emacs probe and atomic activation.
4. Exact Git source acquisition: full commit only, GitHub HTTPS network policy, detached exact checkout, safe tree export, per-file SHA-256 provenance manifest.
5. Package source lock: Paredit, CIDER 2.0.1 and SLY exact source identities plus runtime dependency declarations.
6. Long-lived REPL isolation: CIDER/SLY acceptance uses per-run namespace/function identities.
7. Segmented release gate: a passing Linux `summary.json` can be reused by `accept:alpha16` after strict coverage validation.

## Current test evidence

- TypeScript: 93/93 PASS.
- Agent experiment: 18/18 PASS.
- Refactor intelligence: 29/29 PASS.
- Linux Host: 11/11 PASS.
- Swift portable: 5/5 PASS.
- Resolver: PASS.
- Runtime provisioner: 3/3 PASS.
- Git source acquisition: 3/3 PASS.
- Elisp lexical structure: PASS, 18 files.
- Linux full gate: PASS with GNU Emacs-specific stages marked NOT_RUN.
- Linux reliability: 8/8 PASS, including independent cancellation, stuck-modifier cleanup, focus-theft fail-closed, cross-client desktop lease serialization, target-disappearance fail-closed, 12-cycle soak, and Host restart recovery.

## Explicitly not claimed

This alpha.16 execution session has no usable GNU Emacs 29+ binary. Therefore ERT and real Paredit/CIDER/SLY package runtime were not rerun on the alpha.16 tree. The new private-runtime mechanism is intended to make those gates reproducible once a locked `.deb` set is supplied.
