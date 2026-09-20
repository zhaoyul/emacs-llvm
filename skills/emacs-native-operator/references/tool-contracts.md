# Tool contracts

The MCP server exposes `emacs_health`, `emacs_instances`, explicit session open/close, observe, capabilities, key sequence, command, edit, eval, checkpoint, rollback, wait, and capture.

Never assume current-buffer identity across tool calls. Use the session's stable buffer handle.

Useful capability operations include:

- `list_adapters`
- `adapter_capabilities`
- `adapter_observe`
- `resolve_key`
- `describe_key`
- `where_is`
- `describe`
- `check_feature`
- `list_mode_commands`

`emacs_eval` rejects arbitrary source strings. `trusted_local` may request adapter-defined structured operations against code that already exists in the target buffer.

`emacs_key_sequence` with `internal_keys` accepts Emacs kbd notation, text, structured events, and bounded expect steps. With `native_keys`, use structured event or text steps. The native host focuses and verifies the Emacs PID, injects CGEvents, detects human interference, and the MCP layer observes Emacs before restoring the previous application.

`emacs_capture` requires `trusted_local` and Screen Recording permission. The native PNG is transient: the MCP layer embeds it as image content and removes the temporary file.
