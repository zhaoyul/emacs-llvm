# Emacs Operator Linux Host

The Alpha.13 Linux Host implements the existing local Driver RPC protocol over an X11/XTest backend. It provides verified window focus, canonical key injection, bounded Unicode text injection, foreground restoration, and private PNG window capture.

The host is intentionally capability-driven:

- X11 with XTEST: native keyboard, focus, frontmost query, and capture are available.
- Wayland-only sessions: the host reports native desktop operations unavailable instead of pretending that compositors expose one universal automation API. `semantic` and `internal_keys` remain available through the Emacs Bridge.
- `/dev/uinput`: reserved for a later backend. It can inject kernel input, but does not by itself solve compositor-independent window focus or capture.

Build and run:

```bash
make -C apps/linux-host all
EMACS_OPERATOR_LINUX_BACKEND=x11 npm run linux-host
```

The host writes the same private `driver.json` and token records consumed by `AutoPlatformDriver`.
