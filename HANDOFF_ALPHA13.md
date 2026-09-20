# Alpha.13 Handoff

## Linux source acceptance

```bash
npm run accept:linux
```

Require the real GNU Emacs gates on a workstation that has Emacs 29+:

```bash
EMACS_OPERATOR_LINUX_REQUIRE_EMACS=1 \
EMACS_OPERATOR_LINUX_REQUIRE_GUI_EMACS=1 \
  npm run accept:linux
```

The second command must fail rather than skip when ERT, semantic/runtime workflows, or real Emacs X11 native verification cannot run.

## Linux binary Host bundle

```bash
tar -xzf emacs-operator-linux-host-0.1.0-alpha.13-linux-x86_64.tar.gz
cd emacs-operator-linux-host-0.1.0-alpha.13
./install.sh
EMACS_OPERATOR_LINUX_BACKEND=x11 ~/.local/bin/emacs-operator-linux-host
```

Before installation, verify the release bundle from the source checkout:

```bash
npm run verify:linux-host-bundle -- /path/to/emacs-operator-linux-host-0.1.0-alpha.13-linux-x86_64.tar.gz
```

Runtime dependencies are Node.js 22+, libX11, `libXtst.so.6`, and libpng16. The binary bundle is built for Linux x86_64/glibc. Other architectures should build from source with `npm run linux-host:build`.

## Emacs configuration

```elisp
(add-to-list 'load-path "/path/to/emacs-operator/lisp")
(add-to-list 'load-path "/path/to/emacs-operator/lisp/adapters")
(require 'emacs-operator)
(emacs-operator-mode 1)
```

Start the Linux Host in the same graphical user session and ensure `DISPLAY` points to the X11/XWayland server containing the Emacs frame.

## Wayland

A Wayland-only session intentionally reports native control unavailable in Alpha.13. Continue using `semantic` and `internal_keys`, or launch an X11/XWayland Emacs frame for native desktop verification. Do not grant broad `/dev/uinput` access as a workaround unless a later audited backend explicitly requires it.

## macOS next step

After the real Linux Emacs gate is green, copy the source tree to the Mac and run:

```bash
npm run accept:macos
```

The macOS Host still requires the user to grant Accessibility and Screen Recording permissions. Those approvals cannot be safely automated.

## Evidence to return after local testing

Preserve and return the generated report directory, especially:

```text
summary.json
emacs-runtime.json
workflow-acceptance.json
linux-real-emacs-native.json or macos-native.json
ert.log
```

These files are sufficient for the next Coding Agent to identify the failing layer without guessing from screenshots.
