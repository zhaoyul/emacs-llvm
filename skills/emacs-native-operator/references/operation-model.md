# Operation model

Use the closed loop `observe -> checkpoint -> act -> verify -> eval/test -> commit/rollback`.

Choose channels in this order:

1. `semantic` for exact state, deterministic Org operations, Lisp structural facade operations, structured evaluation, and precise text operations.
2. `internal_keys` when active Emacs keymaps, interactive command semantics, transient maps, minibuffer state, user custom bindings, or an exact package command loop matters.
3. `native_keys` only for real desktop-input verification. It requires the macOS Host, Accessibility permission, `trusted_local`, and a live GUI Emacs process.

Before mode-specific work, call `emacs_capabilities` with `operation="adapter_capabilities"`. Add `scope=["compact","context","adapters"]` to `emacs_observe` when Lisp/Org adapter state is useful.

Every mutation should carry `expected_buffer_tick` whenever the agent observed a buffer immediately before acting. Native execution should additionally use `verify.expected_command` when the final Emacs command is known.

Structured evaluation never accepts source text from the tool call. The source must already exist in the target buffer and be selected by a bounded operation such as `eval_last_sexp`, `eval_defun`, `eval_region`, or Org `execute_babel`.
