# Emacs Operator 0.1.0-alpha.14

A final Linux multi-instance hardening pass also fixes stale-record cleanup when Emacs runs in an isolated/chroot environment without a visible `/proc`: the bridge falls back to kernel signal-0 PID probing before deleting another instance's authentication token. The regression is covered by ERT and by the real two-GUI-Emacs routing acceptance.

Alpha.14 turns Linux into the authoritative real-Emacs acceptance platform and separates package capability discovery from package runtime acceptance.

## Highlights

### Repeatable live Lisp workflows

Workflow fixtures now use per-run function names. Re-running `accept:workflows` against the same long-lived Emacs no longer collides with definitions loaded by a previous acceptance run.

`extract_function` can also reevaluate the enclosing definition after evaluating the generated helper. This closes a real live-runtime gap where the buffer was correct but the old enclosing function remained installed in Emacs.

The repaired suite was run against GNU Emacs 30.2 without restarting the runtime and passed 11/11 gates.

### Package-specific runtime acceptance

New command:

```bash
npm run accept:linux-packages
```

It produces an explicit result for:

- paredit;
- CIDER/nREPL;
- SLY/Slynk.

A missing dependency yields `not_run`. Setting its `EMACS_OPERATOR_LINUX_REQUIRE_*` flag converts missing runtime coverage into a failure.

Paredit acceptance resolves and executes the active package binding through Emacs internal key events. CIDER/SLY acceptance requires a real connection and verifies a buffer-derived definition, value `42`, structured failure, same-target repair, and guarded rerun.

### Package-enabled dedicated Emacs

`accept:linux` can launch its isolated Emacs with trusted extra load paths and a local setup file:

- `EMACS_OPERATOR_LINUX_EMACS_EXTRA_LOAD_PATHS`;
- `EMACS_OPERATOR_LINUX_EMACS_SETUP_FILE`;
- `EMACS_OPERATOR_LINUX_PACKAGE_WAIT_MS`.

This enables CI/local package acceptance without weakening the normal isolated `-Q` baseline.

## Verified in this environment

- GNU Emacs 30.2 ERT: 63 pass, 0 fail, 1 skipped because paredit is absent.
- Real Lisp/Org workflow acceptance after the live-runtime fix: 11/11 pass.
- TypeScript suite before release finalization: 93/93 pass.
- Full current-version Linux hard gate (`accept:linux`) exits 0, including X11/XTEST synthetic input, reliability, installed Host smoke, GNU Emacs runtime/workflows, real Emacs XTEST/capture, and two-live-Emacs routing.
- Package gate soft mode: paredit/CIDER/SLY each report `not_run` because their real dependencies are absent.
- Package gate hard mode: requiring all three exits nonzero and records three explicit policy failures.

- Real two-Emacs routing: 6/6 pass, including fail-closed ambiguous selection plus semantic/internal-key instance isolation.

The cached chroot GNU Emacs emitted a SIGSEGV message while being torn down after every required gate had completed; the Linux acceptance runner still exited 0 and its summary is PASS. This is recorded as a test-runtime teardown warning, not as package/runtime acceptance.

## Not claimed

Alpha.14 does not claim paredit/CIDER/SLY runtime success without their actual dependencies. It also does not claim Wayland native automation or macOS runtime acceptance in the Linux environment.
