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
| Full Linux gate without GNU Emacs | PASS, real-Emacs coverage explicitly NOT_RUN |
| GNU Emacs ERT on current alpha.16 tree | NOT_RUN, GNU Emacs 29+ unavailable in this session |
| Paredit runtime | NOT_RUN |
| CIDER/nREPL runtime | NOT_RUN |
| SLY/Slynk runtime | NOT_RUN |
| Wayland native backend | NOT_IMPLEMENTED |
| macOS local native acceptance | PENDING USER MAC |

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
