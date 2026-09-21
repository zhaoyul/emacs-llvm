# Emacs Operator 0.1.0-alpha.13

Alpha.13 adds the first executable Linux native Host and a repeatable Linux release gate. The implementation reuses the same private Driver RPC contract as the macOS Host, so the MCP server and Agent Skill do not need a Linux-specific tool surface.

## Added

- `apps/linux-host`, a zero-dependency Node.js Driver RPC Host.
- Native `x11-helper` implemented in C with dynamically loaded XTEST.
- X11 process/window discovery, focus, raise, frontmost query, and restoration.
- Canonical keyboard injection for key press/down/up, modifiers, repeats, delays, and named navigation/function keys.
- UTF-8 text injection, including Unicode code points absent from the current X11 layout.
- Private X11 window PNG capture using `XGetImage` and libpng.
- Deterministic `x11-probe` applications for native acceptance.
- Linux runtime/token discovery with private permissions and heartbeat.
- Desktop-operation serialization and cancellation.
- Linux installer, uninstaller, optional systemd user service, and architecture-specific runtime bundle packaging.
- `accept:linux`, `accept:linux-x11`, `accept:linux-sanitized`, and `accept:alpha13` release gates.
- Real-GNU-Emacs Linux native acceptance code that activates automatically when GNU Emacs is available.
- Machine-readable Wayland-only and uinput capability reports.

## Fixed

- Repaired malformed newline literals generated in the Alpha.12 Agent Driver sources and tests.
- Prevented an X11 Unicode mapping race by keeping temporary Unicode key mappings alive for a bounded grace period before restoration.
- Extended native application records with window title and window identifier so X11 restoration can return to the exact prior window where possible.
- Generalized native capture and desktop-control error guidance so it is no longer macOS-only wording.
- Increased native event-log acceptance tolerance to avoid false negatives under a busy CI scheduler.
- Replaced the shared Driver RPC fixed five-second timeout with bounded per-operation budgets for focus, native key sequences, capture, restore, and cancellation.
- Hardened Driver discovery against symlink records, non-private runtime state, owner mismatch, token-path escape, invalid ports/PIDs, and heartbeat future skew.
- Hardened Linux Host runtime creation against symlink runtime directories and stale token symlinks.
- Added best-effort cleanup for partially pressed modifiers, dynamic Unicode mappings, and failed key releases.
- Bounded X11 capture dimensions/source pixels and fixed truncated UTF-8 handling in the native helper.
- Added standalone Linux Host bundle manifest verification plus isolated install/start/authenticate/uninstall smoke.

## Verified

- TypeScript tests: 90/90 PASS.
- Agent experiment tests: 18/18 PASS.
- Linux Host tests: 11/11 PASS.
- X11/XTEST acceptance gates: 10/10 PASS.
- ASan/UBSan native acceptance: PASS.
- Linux Host installation smoke: PASS.
- MCPB integrity and extracted-server startup: PASS.
- Standalone Linux x86_64 Host bundle smoke: PASS.
- Missing-GNU-Emacs hard-gate negative path: PASS, with machine-readable `failed_stage=emacs_required`.

## Explicit boundaries

GNU Emacs is unavailable in the build container, so ERT and real Emacs runtime/native acceptance are not claimed. Wayland-native and uinput execution are not implemented. X11 human-interference detection and cursor-inclusive capture are also not advertised.
