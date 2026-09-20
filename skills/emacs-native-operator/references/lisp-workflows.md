# Lisp workflows

For structural Lisp edits:

1. Observe with adapter scope and inspect current defun, sexp bounds, parse depth, string/comment state, namespace/package, active region, and paredit/smartparens availability.
2. Query `emacs_capabilities` with `operation="adapter_capabilities"` and `adapter="lisp"`.
3. Prefer the semantic facade `emacs-operator-lisp-structural-edit` when the requested operation is one of `forward_sexp`, `backward_sexp`, `slurp_forward`, `barf_forward`, `splice`, `wrap_round`, `raise`, `split`, `join`, or `indent_defun`.
4. The facade resolves the best provider at runtime. It prefers the enabled paredit/smartparens mode, then a loaded structural package, then a built-in fallback when one is valid. Never assume paredit is installed.
5. For mutating structural operations, create a checkpoint for multi-step work. The facade performs each operation atomically and refuses to leave the buffer unbalanced.
6. Inspect `adapter_verification`; require `balanced=true` before continuing.
7. Use structured `emacs_eval` only under `trusted_local`. Supported source selectors are buffer-derived `eval_last_sexp`, `eval_defun`, and `eval_region`. Caller-provided source strings are forbidden.
8. For Clojure/Common Lisp, inspect the CIDER/SLY adapter connection state before evaluation. A live connection, namespace/package, and prompt-ready state are required.
9. Commit on success, rollback on failure.

Do not implement slurp, barf, splice, wrap, raise, split, or join by textual parenthesis surgery when a structural provider is available.
