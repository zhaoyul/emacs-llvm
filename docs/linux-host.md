# Linux Native Host

Version: `0.1.0-alpha.13`

The Linux Host implements the same authenticated local Driver RPC contract used by the MCP server and the macOS Host. Alpha.13 provides a production-shaped X11/XTest backend and conservative capability negotiation for unsupported Linux desktop environments.

## Supported backend

### X11/XTest

When `DISPLAY` points to an X11 server with the XTEST extension, the host provides:

- target-window lookup by PID plus X11 window identifier or title;
- verified focus and raise before input;
- physical-style key down/up injection through XTEST;
- canonical modifiers and named navigation/function keys;
- bounded Unicode text injection through temporary X11 Unicode keysym mapping;
- previous-foreground-window restoration;
- bounded target-window PNG capture;
- authenticated loopback Driver RPC discovery through private runtime files.

The backend reports itself as `x11_xtest`.

### Wayland

A Wayland-only session is not claimed as natively controllable in Alpha.13. The host returns a connected or unavailable capability result with:

```json
{
  "backend": "unavailable",
  "display_server": "wayland",
  "native_keyboard": false,
  "window_focus": false,
  "window_capture": false
}
```

Use `semantic` and `internal_keys` through the Emacs Bridge in this situation. XWayland can be used only for Emacs frames that are actually X11/XWayland windows.

### uinput

`/dev/uinput` is detected and reported but is not an Alpha.13 backend. Kernel input injection alone does not identify, focus, verify, or capture a target application window. A future uinput implementation must therefore be paired with an explicit compositor/window-management contract rather than presented as universal Linux desktop control.

## Security model

The host:

- listens only on `127.0.0.1` using a random port;
- publishes `driver.json`, a token file, and `host.lock` in a private `0700` runtime directory;
- writes token and record files with `0600` permissions;
- authenticates the first RPC call with a random 256-bit token;
- limits connection count, requests per connection, message size, event count, text bytes, and cumulative delays;
- rejects unbalanced key-down/key-up plans before injection;
- serializes focus/input/capture operations across callers;
- releases held modifiers and keys after a native failure;
- places captures in a private directory and treats them as transient files;
- refuses cursor compositing rather than silently returning an incomplete cursor capture;
- rejects runtime/record/token symlinks, token paths outside the runtime directory, owner mismatch, broad permissions, stale heartbeats, and future-skewed records;
- uses operation-specific bounded RPC deadlines so a valid long key sequence is not aborted by a shorter transport timeout;
- bounds source capture dimensions/pixels before `XGetImage` allocation and validates UTF-8 sequences without reading past their supplied length.

Alpha.13 cannot reliably distinguish injected XTEST events from simultaneous human input. `user_interference_detection` is therefore reported as `false`. Native input should be used only for explicit desktop-level tests while the target session is controlled.

## Build dependencies

Runtime/build prerequisites on Debian-like systems are equivalent to:

- Node.js 22+;
- C compiler and make;
- Xlib development headers and runtime;
- libXtst runtime;
- libpng development headers and runtime.

The helper loads `libXtst.so.6` dynamically, so an XTest development header is not required by the current implementation.

Run the runtime-only prerequisite check:

```bash
EMACS_OPERATOR_LINUX_PREFLIGHT_MODE=runtime ./scripts/linux-preflight.sh
```

Build:

```bash
npm run linux-host:build
```

Run in the current X11 session:

```bash
EMACS_OPERATOR_LINUX_BACKEND=x11 npm run linux-host
```

The default `auto` mode selects X11 only when a usable `DISPLAY` is present. It does not pretend that a Wayland-only compositor supports the same controls.

## Installation

Install under `~/.local`:

```bash
./scripts/install-linux-host.sh
```

The launcher is installed as:

```text
~/.local/bin/emacs-operator-linux-host
```

Start it from the graphical session:

```bash
emacs-operator-linux-host
```

Optional systemd user installation:

```bash
EMACS_OPERATOR_INSTALL_SYSTEMD_USER=1 ./scripts/install-linux-host.sh
```

The systemd unit deliberately does not use `PrivateTmp=true`, because the MCP server must discover the host's private `driver.json` in the same user-visible runtime namespace. File permissions and the random token remain the authentication boundary.

A non-default prefix is supported for direct installation and tests:

```bash
EMACS_OPERATOR_LINUX_PREFIX=/opt/emacs-operator-user ./scripts/install-linux-host.sh
```

Systemd user installation currently requires the default `~/.local` prefix.

Uninstall:

```bash
./scripts/uninstall-linux-host.sh
```

## Standalone binary bundle

Build the architecture-specific bundle:

```bash
npm run package:linux-host
```

Verify the bundle independently of the source tree:

```bash
npm run verify:linux-host-bundle -- /path/to/emacs-operator-linux-host-0.1.0-alpha.13-linux-x86_64.tar.gz
```

The release gate verifies safe archive paths/types, every manifest size and SHA-256, an isolated installation, Xvfb startup, authenticated Driver RPC capability negotiation, and complete uninstall residue removal.

## Driver selection and runtime paths

Environment variables:

```text
EMACS_OPERATOR_LINUX_BACKEND=auto|x11
EMACS_OPERATOR_DRIVER_RUNTIME_DIR=/private/runtime/directory
EMACS_OPERATOR_CAPTURE_DIR=/private/capture/directory
```

The MCP server and Linux Host must resolve the same `EMACS_OPERATOR_DRIVER_RUNTIME_DIR` when a custom path is used. Without an override, both use:

```text
/tmp/emacs-operator-driver-<uid>
```

## Known Alpha.13 limits

- Wayland-native focus, injection, and capture are not implemented.
- uinput is capability-detected only.
- concurrent human-input interference detection is not implemented on X11.
- cursor compositing is not available in window captures.
- X11 authorization is inherited from the user's current graphical session.
- native input requires the target Emacs frame to be a real X11/XWayland window and to accept focus.
