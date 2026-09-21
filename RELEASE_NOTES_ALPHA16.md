# Emacs Operator 0.1.0-alpha.16

Alpha.16 is the Linux acceptance reproducibility release.

## Highlights

- Fixed shell-to-shell invocation so source archive executable-bit loss cannot cause `Permission denied` in Linux/macOS acceptance orchestration.
- Added a GNU Emacs 29+ resolver with explicit binary, private-runtime-root, project-private runtime, and PATH discovery.
- Added a SHA-256 and Debian-metadata locked private Emacs runtime provisioner for local `.deb` sets.
- Added exact-commit Git source acquisition with provenance manifests for Paredit, CIDER, and SLY.
- Added the pinned package source catalog for Paredit, CIDER 2.0.1, and SLY.
- Made CIDER/SLY package acceptance identities unique per run so long-lived REPL state cannot create false success or name collisions.
- Added `accept:alpha16` with machine-readable segmented evidence and optional reuse of an already-passing `accept:linux` report.
- Revalidated Linux X11/XTEST native input and all eight reliability gates on the alpha.16 source tree.

## Current authoritative result in this environment

Required alpha.16 gates: PASS.

- TypeScript main suite: 93/93 PASS.
- Agent experiment wrapper: 18/18 PASS.
- Refactor intelligence: 29/29 PASS.
- Linux Host: 11/11 PASS.
- Swift portable: 5/5 PASS.
- Emacs resolver tests: PASS.
- Private runtime provisioner tests: 3/3 PASS.
- Exact source acquisition tests: 3/3 PASS.
- Linux X11/XTEST native acceptance: PASS.
- Linux reliability acceptance: 8/8 PASS.
- Linux Host install/uninstall smoke: PASS.
- GNU Emacs ERT on the alpha.16 tree: NOT_RUN in this session because no GNU Emacs 29+ binary is currently available.
- Paredit/CIDER/SLY real package runtime: NOT_RUN for the same runtime/dependency reason.

`NOT_RUN` is intentionally not reported as PASS. A private GNU Emacs runtime can now be provisioned without modifying system package sources.
