# Linux Acceptance

Version: `0.1.0-alpha.13`

The Linux acceptance suite validates the Linux Host as a real platform adapter rather than a mocked keyboard API. Its deterministic native path uses a private Xvfb display, two actual X11 windows, XTEST input, foreground restoration, and PNG capture.

## Run

```bash
npm run accept:linux
```

Choose a report directory:

```bash
EMACS_OPERATOR_LINUX_ACCEPTANCE_REPORT_DIR=/tmp/emacs-operator-linux-report \
  npm run accept:linux
```

The runner does not require an existing desktop session. It allocates an unused X display and launches a private Xvfb server.

## Required native gates

The Alpha.13 Linux release gate performs:

1. Linux prerequisite inspection.
2. Version consistency validation.
3. Portable Emacs Lisp structural scan.
4. TypeScript build and tests.
5. Agent wrapper tests.
6. Benchmark corpus/profile validation, unless explicitly disabled.
7. Linux Host Node tests.
8. Native helper build with compiler warnings enabled.
9. Installer, installed-launcher, authenticated Driver discovery, and uninstaller smoke.
10. Two real X11 probe windows under Xvfb.
11. Exact initial foreground-window establishment.
12. MCP `emacs_key_sequence` through `ToolRouter`, `AutoPlatformDriver`, TCP Driver RPC, and XTEST.
13. Plain, modified, shifted, Unicode, and navigation key observation by the target X11 window.
14. Previous-window restoration.
15. Target-window PNG capture and transient-file consumption.
16. Unbalanced key-plan rejection.
17. Explicit cursor-capture rejection.
18. Wayland-only conservative capability negotiation.
19. uinput capability reporting without an implementation claim.
20. Driver discovery hardening for symlink, owner, mode, token-path, PID/port, and heartbeat checks.
21. AddressSanitizer and UndefinedBehaviorSanitizer repetition of the native X11 path.
22. Architecture-specific Linux Host bundle packaging, safe-archive inspection, manifest verification, isolated install/start/authenticate/uninstall smoke.
23. Production MCPB packaging, archive integrity, development-test exclusion, extracted-server `initialize`, and `emacs_health`.

This path is a real X11/XTEST acceptance test. The target is a deterministic X11 probe rather than Emacs, allowing the native layer to be tested even when GNU Emacs is not installed.

## Optional real GNU Emacs gates

When `emacs` is available, the same command also requires ERT:

```text
npm run test:elisp
```

It then attempts to start an isolated graphical `emacs -Q` on the private Xvfb display and runs:

- real Bridge discovery and authentication;
- semantic runtime acceptance;
- Lisp/Org workflow acceptance;
- native Ctrl+A and Unicode insertion into a real Emacs buffer;
- semantic verification of the resulting buffer text;
- foreground restoration;
- real Emacs window capture.

Missing GNU Emacs is reported as `not_run`, not `pass`. Make it a hard requirement with:

```bash
EMACS_OPERATOR_LINUX_REQUIRE_EMACS=1 npm run accept:linux
```

Require a graphical Emacs Bridge and all real GUI gates with:

```bash
EMACS_OPERATOR_LINUX_REQUIRE_EMACS=1 \
EMACS_OPERATOR_LINUX_REQUIRE_GUI_EMACS=1 \
  npm run accept:linux
```

## Benchmark switch

Benchmark corpus/profile validation is enabled by default. It can be disabled for a focused native-driver iteration:

```bash
EMACS_OPERATOR_LINUX_RUN_BENCHMARKS=0 npm run accept:linux
```

This does not run paid/networked LLM comparisons.

## Reports

The report directory includes:

```text
summary.json
preflight.log
version.log
elisp-structure.log
typescript-tests.log
agent-experiment-tests.log
benchmark-corpus.log
linux-host-tests.log
linux-host-build.log
install-smoke.json
install-smoke.log
linux-native.json
linux-native.log
wayland-capability.json
uinput-capability.json
ert.log
emacs-runtime.json
workflow-acceptance.json
linux-real-emacs-native.json
```

The Alpha.13 release-level report additionally contains the standalone Host bundle, `linux-host-bundle.json`, sanitizer evidence, the production MCPB, and a unified `summary.json`.

`summary.json` distinguishes:

```text
pass
fail
not_run
not_implemented
```

The following are not equivalent:

- `x11_xtest_synthetic_target=pass`: the platform Host and MCP path passed against real X11 probe windows.
- `real_emacs_x11_native=pass`: the same path altered and verified a real Emacs buffer.
- `gnu_emacs_ert=not_run`: Emacs was unavailable and no semantic runtime claim was made.
- `wayland_native=not_implemented`: no universal compositor contract has been implemented.

## CI recommendation

A Linux CI job should install GNU Emacs with GUI support, Xvfb, X11 utilities, Xlib/libpng development packages, and the libXtst runtime, then run:

```bash
EMACS_OPERATOR_LINUX_REQUIRE_EMACS=1 \
EMACS_OPERATOR_LINUX_REQUIRE_GUI_EMACS=1 \
  npm run accept:linux
```

Until that job has actually run on the target CI image, it is a planned authoritative gate rather than completed evidence.
