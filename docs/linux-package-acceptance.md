# Linux package-specific runtime acceptance

Alpha.14 separates package discovery from real package execution. `featurep` or adapter capability output is diagnostic information only; it is not a package acceptance pass.

## Command

Against an already running Linux Emacs Operator instance:

```bash
npm run accept:linux-packages
```

The machine-readable report defaults to `dist/acceptance/linux-packages.json`. Override it with:

```bash
EMACS_OPERATOR_LINUX_PACKAGE_ACCEPTANCE_REPORT=/tmp/linux-packages.json \
npm run accept:linux-packages
```

Select a specific live instance with `EMACS_OPERATOR_LINUX_PACKAGE_INSTANCE_ID`.

## Status semantics

Each package is one of:

- `pass`: the package-specific runtime workflow actually executed successfully;
- `not_run`: package, mode, or external runtime connection is unavailable;
- `fail`: package/runtime was available but the acceptance behavior failed, or a required package was unavailable.

Hard requirements:

```bash
EMACS_OPERATOR_LINUX_REQUIRE_PAREDIT=1
EMACS_OPERATOR_LINUX_REQUIRE_CIDER=1
EMACS_OPERATOR_LINUX_REQUIRE_SLY=1
```

## Paredit gate

1. Open a temporary balanced Emacs Lisp fixture.
2. Enable the real `paredit-mode` command.
3. Confirm the `paredit` feature is loaded.
4. Resolve the active binding for `paredit-forward-slurp-sexp` in the target buffer.
5. Execute that binding through `internal_keys`.
6. Verify Emacs `last-command` is `paredit-forward-slurp-sexp`.
7. Require the expected structural transformation and balanced delimiters.

This tests the package through the actual Emacs command loop and current keymap.

## CIDER gate

The fixture is a real Clojure buffer. The gate requires the CIDER adapter to be applicable and `prompt_ready=true` with a live nREPL connection.

It then performs:

1. buffer-derived `eval_defun`;
2. buffer-derived representative call, expected `42`;
3. verification ticket on a deliberate runtime failure;
4. semantic replacement of the same source target;
5. guarded rerun, expected `42`.

No fake nREPL server is used.

## SLY gate

The SLY gate mirrors the CIDER contract in a Common Lisp buffer with a real SLY/Slynk connection. No fake Slynk server is used.

## Dedicated package-enabled Linux acceptance

The full Linux runner normally starts an isolated `emacs -Q`. To add package dependencies without loading an ordinary user init file:

```bash
EMACS_OPERATOR_LINUX_EMACS_EXTRA_LOAD_PATHS=/opt/elisp/paredit:/opt/elisp/cider:/opt/elisp/sly \
EMACS_OPERATOR_LINUX_EMACS_SETUP_FILE=/opt/emacs-operator/package-acceptance.el \
EMACS_OPERATOR_LINUX_PACKAGE_WAIT_MS=30000 \
EMACS_OPERATOR_LINUX_REQUIRE_PAREDIT=1 \
EMACS_OPERATOR_LINUX_REQUIRE_CIDER=1 \
EMACS_OPERATOR_LINUX_REQUIRE_SLY=1 \
npm run accept:linux
```

The setup file is trusted local test configuration. It may load packages and establish local runtime connections. The runner waits a bounded interval for CIDER/SLY readiness. Maximum wait is 60 seconds.

Example skeleton:

```elisp
(require 'paredit)
(require 'cider nil t)
(require 'sly nil t)

;; Establish local nREPL/Slynk connections here when those gates are required.
;; Keep this file deterministic and dedicated to acceptance.
```

For ERT, `scripts/run-ert.sh` also honors `EMACS_OPERATOR_LINUX_EMACS_EXTRA_LOAD_PATHS`, allowing the conditional paredit ERT case to run when the package is installed in a nonstandard test directory.
