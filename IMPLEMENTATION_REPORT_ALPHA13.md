# Alpha.13 Linux Implementation Report

## Objective

Deliver a Linux test and acceptance implementation before macOS local acceptance, while preserving the existing three-channel model:

```text
semantic       -> Emacs Bridge and structured adapters
internal_keys  -> Emacs command loop and active keymaps
native_keys    -> platform Host and operating-system input
```

Alpha.13 implements the Linux `native_keys` Host for X11/XWayland-compatible windows. It does not alter the public MCP tools.

## Architecture

```text
MCP ToolRouter
    |
    v
AutoPlatformDriver
    |
    | localhost TCP, Content-Length JSON-RPC, token auth
    v
Linux Host, Node.js
    |
    +-- private runtime record and heartbeat
    +-- serialized desktop lease
    +-- event validation and bounded plan file
    +-- private capture directory
    |
    v
x11-helper, C
    |
    +-- Xlib window discovery/focus
    +-- XTEST keyboard injection
    +-- temporary Unicode keysym mapping
    +-- XGetImage + libpng capture
```

The Host publishes the same `driver.json` and token format used by the shared TypeScript client. A connected MCP server therefore selects Linux or macOS through runtime discovery rather than platform-specific Agent instructions.

## X11 target resolution

The helper resolves an exact target in this order:

1. Validate a supplied native X11 window identifier and its `_NET_WM_PID`.
2. Match the requested PID and optional frame title.
3. Recursively inspect the X11 window tree for a viewable matching client window.
4. Raise, map, request `_NET_ACTIVE_WINDOW`, call `XSetInputFocus`, and verify focus ownership.

The previous focused window is returned with PID, title, and native identifier. Restoration prefers the exact identifier rather than a PID-only guess.

## Input model

Canonical events are converted into a private, bounded, base64-field event plan. The native helper supports:

- `key_press`, `key_down`, `key_up`, and `text`.
- Control, Shift, Alt/Meta/Option, Super/Command, and Hyper.
- Named keys, arrows, paging keys, F1-F24, and DOM-style `KeyA`/`Digit1` codes.
- Repeats and bounded per-event delays.
- Balanced down/up validation before injection.

Every failure path releases held keys. A sequence ending with an unmatched `key_down` is rejected before the native helper is invoked.

## Unicode strategy

XTEST injects keycodes, while many Unicode code points are not mapped by the active X11 keyboard layout. For such characters the helper:

1. Selects a scratch keycode.
2. Saves its original mapping.
3. Temporarily maps the Unicode keysym.
4. Injects press/release through XTEST.
5. Keeps the mapping alive for a bounded grace period so the target client can resolve the event.
6. Restores the exact original mapping.

The grace period defaults to 75 ms and is bounded to 0-500 ms through `EMACS_OPERATOR_X11_UNICODE_HOLD_MS`.

## Capture

The helper captures only the resolved target window. It reads pixels with `XGetImage`, optionally downsizes to a bounded width, encodes RGB PNG through libpng, and creates the output with mode 0600. The MCP server verifies the capture directory, real path, regular-file status, permissions, size, and PNG signature, then deletes the transient file after consumption.

Cursor compositing is not implemented and requests for `include_cursor=true` are rejected rather than silently ignored.

## Acceptance design

The required Linux gate starts a private Xvfb server and two real X11 processes. One is the target, the other is the previously focused application. It then exercises:

```text
Fake deterministic Emacs Bridge
        +
ToolRouter native_keys/capture
        +
AutoPlatformDriver discovery/authentication
        +
Linux Host Driver RPC
        +
X11/XTEST and XGetImage
```

The gate checks plain keys, Control-modified keys, Shift behavior, Unicode `你`, a Left navigation key, frontmost restoration, capture consumption, stuck-key rejection, and unsupported cursor-capture rejection.

A second gate rebuilds the C binaries with AddressSanitizer and UndefinedBehaviorSanitizer and repeats the native path.

## Capability negotiation

- X11 with XTEST: native keyboard, focus, frontmost query, and capture are advertised.
- Wayland-only: native capabilities are false with an explicit reason and fallback guidance.
- uinput: device presence/writability is reported, but execution remains disabled because it does not provide target-window focus or capture.

## Verification result

The final Alpha.13 release gate passed. See the machine-readable release report and Linux evidence bundle. GNU Emacs runtime gates remain `not_run` because the container has no Emacs binary and cannot resolve the Debian package mirror.
## Final hardening and release verification

The final Alpha.13 pass tightened the shared and Linux-specific security boundary before packaging:

- Driver discovery accepts only a private, current-user-owned, non-symlink runtime directory, record, and token. The token path must resolve inside that directory. PID, port, heartbeat age, and future clock skew are validated.
- Native operations use per-method transport deadlines. A bounded 60-second input plan now has a 95-second RPC budget instead of being contradicted by the previous five-second client timeout.
- Linux runtime creation refuses a symlink directory before changing permissions and replaces a stale token symlink without following it.
- The C helper cleans up partially pressed modifiers/keys, preserves retry state after release failures, bounds Unicode cleanup, validates truncated UTF-8 safely, and caps capture dimensions/source pixels.
- A standalone x86_64/glibc Host bundle is verified by manifest hash/size checks and an isolated Xvfb install/start/authenticate/uninstall smoke test.
- The complete native path is repeated under AddressSanitizer and UndefinedBehaviorSanitizer. Clang static analysis is also run separately.

The final portable counts are 90/90 TypeScript tests, 18/18 Agent experiment tests, 11/11 Linux Host tests, and 10/10 live X11/XTEST gates. The missing-Emacs hard-gate negative path also passes by failing deliberately with `failed_stage=emacs_required`. The GNU Emacs runtime gates remain explicitly `not_run` in this container.
