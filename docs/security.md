# Security baseline

- Emacs Bridge and macOS Host listen on `127.0.0.1` only.
- Each process owns a random 256-bit token stored in a mode-0600 file under a mode-0700 runtime directory.
- Runtime discovery rejects dead/stale PIDs and malformed records.
- Token material is never written to audit logs.
- Sessions use explicit permission profiles. `native_keys`, structured language evaluation and screen capture require `trusted_local`.
- `workspace_edit` restricts mutations to the resolved project root and denies native input.
- Arbitrary source-string Emacs Lisp evaluation remains disabled.
- Structured Org Babel execution uses only the current buffer block, requires the language to be explicitly enabled, and still honors Org `:eval no`/`:eval never`; after `trusted_local` authorization, a query-only `:eval query` is suppressed for that one copied execution descriptor without changing the buffer or the user's Org configuration.
- Native input is unavailable unless the Host explicitly reports Accessibility trust.
- Before CGEvent injection, the Host raises the target Emacs process/window and verifies the frontmost PID.
- A listen-only event tap detects human keyboard/mouse interference during injection. Injection then stops and modifiers are released.
- Native capture requires Screen Recording permission and captures only the selected Emacs window.
- PNG captures live in a private transient directory, are checked for path/mode/signature/size by the MCP server, embedded as MCP image content, then deleted.
- Native driver failure never silently degrades into a different execution channel.
- Buffer-derived Lisp evaluation is capped at 256 KiB per operation by encoded byte size, including last-sexp, defun and active-region evaluation.

- High-level `emacs_workflow` guarantees checkpoint-managed buffer rollback, not rollback of arbitrary Lisp REPL, Babel, filesystem, process, network, database, or other runtime side effects. Outcomes expose `transaction_scope` when this distinction matters.
- Alpha.8 `rename_symbol` is bounded to current defun/buffer and skips strings/comments; it is not a project-wide semantic rename.
- Alpha.8 `extract_function` accepts only complete buffer-derived forms, constrains generated symbol tokens, rejects duplicate parameters and existing function-name collisions, and never accepts a caller-supplied arbitrary function body/call expression.
- Alpha.8 Org subtree rewrite rejects raw heading injection through body text, constrains tag tokens, and bounds property values.
