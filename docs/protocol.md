# Protocol notes

## MCP side

The MCP stdio server uses newline-delimited JSON-RPC 2.0 and supports initialize, ping, tools/list and tools/call. Stateful operations require an explicit server-generated `session_id`.

## Emacs bridge side

The Emacs bridge uses JSON-RPC 2.0 semantics over loopback TCP with LSP-style `Content-Length` framing. The first successful request on a connection must be `initialize` with the per-instance token.

## macOS Host side

`EmacsOperatorHost.app` also exposes authenticated loopback JSON-RPC with `Content-Length` framing. The MCP process discovers `driver.json`, validates PID/heartbeat/token permissions, calls `driver.initialize`, and negotiates capabilities instead of assuming native input is available.

Host capabilities are independent. A connected host may report `window_focus=true` while `native_keyboard=false`, or `window_capture=false` when Screen Recording permission is absent.

Native input is sent as canonical structured key events. The Host converts them to macOS virtual key codes/modifier events, tags injected CGEvents, checks for human interference, and returns stable errors.



## High-level semantic transaction semantics

The MCP-only `emacs_workflow` tool coordinates existing allowlisted tools; it is not a new Bridge eval endpoint. Supported operations are `repair_lisp`, `refactor_defun`, and `org_build_section`. Every mutation workflow creates a checkpoint before editing and either commits after validation/verification or automatically rolls back a failed proposal.

A proposal failure such as invalid Lisp structure, a language runtime condition, or an unexpected expected-value check returns a normal MCP success envelope whose `workflow.status` is `rolled_back`. Authentication, policy, workspace, stale-state, Bridge/driver, schema, or rollback failures remain tool errors.

Lisp workflow evaluation is still buffer-derived. Only `eval_last_sexp`, `eval_defun`, and `eval_region` are accepted, at most eight steps per transaction. A step may first perform one deterministic semantic navigation operation and may require an exact stringified `expected_value`. Caller-supplied source strings remain unsupported.

## Adapter structural validation

The MCP tool `emacs_validate` maps to Bridge method `adapter.validate`. It is read-only and may be used from a read-only session. The caller may optionally select a specific adapter. A validator returns structure status and machine-readable diagnostics while keeping invalid document state as data so an agent can repair it. If no applicable active adapter exposes a validator, the Bridge returns `E_COMMAND_NOT_FOUND` instead of treating an empty validation set as success.

Current validators:

- `lisp`: delimiter balance plus reader validation for Emacs Lisp, with bounded context around diagnostic positions.
- `org`: Org element parsing, block delimiter checks, current heading/table/Babel state, and a bounded whole-document structural summary.

Program runtime errors are separate from validation. Structured buffer-derived evaluation may return `completed=false`, `condition`, `stderr`, and `backtrace_handle` without converting the language-level failure into a transport error.


## Safe noninteractive command return values

`emacs_command` may call only commands that are interactive or explicitly registered in the Bridge safe-noninteractive allowlist. For a safe noninteractive command, the Bridge now preserves a JSON-friendly command return value under `execution.return_value`. This is the semantic result channel used by structured helpers such as Org constructors; it is distinct from stdout/messages and from the MCP tool envelope itself.

The return value must remain bounded and serializable. Agent-callable arbitrary Elisp evaluation is not introduced by this mechanism.

## Structured evaluation failure semantics

Language/runtime errors are data when the Bridge and REPL transport itself remain healthy. Buffer-derived Lisp source is capped at 256 KiB per evaluation by encoded byte size. A structured evaluation result uses `completed=true` for a successful language evaluation and `completed=false` for a repairable language failure. Emacs Lisp failures include bounded diagnostic metadata such as source bounds/size/hash, position, line/column, condition data, captured messages and a bounded backtrace. CIDER/SLY normalize their runtime results into the same high-level envelope where possible.

A caller should therefore distinguish:

- MCP/Bridge transport or policy error: tool envelope `ok=false`;
- program/runtime error: tool envelope `ok=true`, evaluation result `completed=false`;
- successful evaluation: tool envelope `ok=true`, evaluation result `completed=true`.

## Whole-document Org validation summary

The Org validator exposes a bounded structural summary of the full target document. It reports total counts plus capped metadata for headings, tables and source blocks. Source-block bodies are deliberately omitted; only metadata such as language, parameters and body byte count is returned. `options.max_nodes` bounds the number of returned nodes per structural category.
