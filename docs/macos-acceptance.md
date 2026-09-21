# macOS Native Acceptance

This checklist validates the parts of Emacs Operator that cannot be proven in a Linux CI container: AppKit process focus, Accessibility window selection, Quartz CGEvent injection, ScreenCaptureKit capture, and foreground restoration.


## One-command full acceptance

After the Host has been installed and macOS Accessibility/Screen Recording permissions have been granted, run:

```bash
npm run accept:macos
```

By default this command starts a dedicated `emacs -Q` graphical instance with its own temporary Bridge runtime, runs portable checks, ERT, Swift tests, real Emacs semantic/internal-key acceptance, and native CGEvent/capture acceptance, then removes the dedicated instance. It writes machine-readable and text reports under `dist/acceptance/<timestamp>/`. A `summary.json` is written on both success and failure; failed runs include `failed_stage` and the shell exit code so a remote coding agent can immediately identify which gate stopped the suite.

Set `EMACS_OPERATOR_ACCEPTANCE_USE_EXISTING=1` to test an existing Emacs Operator instance instead. First-run TCC approval is intentionally not automated.

See `docs/runtime-acceptance.md` for the non-native real-Emacs gates.

## Prerequisites

- macOS 14 or later.
- GNU Emacs 29 or later with a graphical frame.
- Node.js 22 or later.
- Swift 6 toolchain / current Xcode Command Line Tools.
- Emacs Operator Elisp installed and running.
- EmacsOperatorHost.app built and running.
- Accessibility permission granted to EmacsOperatorHost.
- Screen Recording permission granted to EmacsOperatorHost.

Run the preflight first:

```bash
./scripts/macos-preflight.sh
```

## Automated native smoke test

Leave a normal Emacs buffer selected. Prefer running the command below from Terminal while Terminal is frontmost, because that also exercises restoring focus back from Emacs to the previous application.

```bash
npm run accept:macos-native
```

If more than one Emacs bridge instance is running, select one explicitly:

```bash
EMACS_OPERATOR_ACCEPTANCE_INSTANCE_ID=<instance-id> npm run accept:macos-native
```

The acceptance runner deliberately uses `C-a` because it normally moves point without modifying buffer contents. It first asks Emacs which command `C-a` resolves to in the current active keymaps, then sends a real macOS Control+A event and requires Emacs to report that same command after execution. Custom bindings are therefore handled rather than hard-coded.

The runner verifies:

1. Native host discovery and token authentication.
2. Accessibility and Screen Recording permission state.
3. Live graphical Emacs bridge discovery.
4. `trusted_local` session creation.
5. Current-keymap resolution for `C-a`.
6. Real CGEvent keyboard injection through `native_keys`.
7. Post-action verification using Emacs command telemetry.
8. Restoration of the previous foreground application when Emacs was not already frontmost.
9. Window-specific ScreenCaptureKit PNG capture.
10. Reading the PNG through the MCP layer and deletion of the transient capture file.
11. Session cleanup.

A passing run ends with:

```text
PASS  macOS native acceptance  all automated gates passed
```

## Manual interference cancellation test

The automated smoke test does not intentionally synthesize human interference. Validate this separately:

1. Start an agent native-key sequence long enough to contain multiple events and delays.
2. While the sequence is running, press a physical key or move/click the mouse.
3. The host must mark `user_interference_detected=true` or cancel the sequence.
4. Any held synthetic modifier must be released.
5. No subsequent queued synthetic events may continue after cancellation.

## Multi-frame target test

To validate frame targeting:

1. Create two graphical Emacs frames with different frame titles.
2. Select a buffer in each frame and inspect them through `emacs_observe`.
3. Confirm each resolved target exposes its `frame_title`; where supported by the Emacs build, it also exposes `native_window_identifier` from `outer-window-id`.
4. Open a session against each frame independently.
5. Run `native_keys` and `emacs_capture` for each session.
6. Verify the correct OS window is raised and captured for both sessions.

Window selection uses the following priority:

1. Exact Accessibility identifier, when exposed.
2. Emacs `outer-window-id` matched to the CoreGraphics window and then to AX geometry, when compatible.
3. Exact frame title.
4. Focused application window.
5. First available application window as a final fallback.

## Failure interpretation

- `E_NATIVE_DRIVER_UNAVAILABLE`: host process/driver record is not available.
- `E_ACCESSIBILITY_NOT_GRANTED`: grant Accessibility permission and restart the host if macOS requires it.
- `E_SCREEN_CAPTURE_NOT_GRANTED`: grant Screen Recording permission and restart the host if required.
- `E_FOCUS_FAILED`: Emacs process/window could not be raised or verified frontmost.
- `E_USER_INTERFERENCE`: physical input interrupted native automation.
- `E_COMMAND_FAILED` after a native key: the OS event was sent but Emacs did not report the expected command.
- `E_CAPTURE_FAILED`: ScreenCaptureKit could not identify or capture the requested Emacs window.

Do not mark Phase 7 or Phase 8 platform acceptance complete until this test passes on a real Mac.
