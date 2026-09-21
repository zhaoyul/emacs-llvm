---
name: emacs-native-operator
description: Operate GNU Emacs through semantic RPC, Emacs-internal key events, and guarded OS-native keyboard input. Use for editing Lisp structurally, authoring Org documents, running Emacs commands, interacting with minibuffers and REPLs, or verifying real desktop key behavior.
---

# Emacs Native Operator

## Purpose

Use this skill whenever the task should be performed inside GNU Emacs, especially when major modes, minor modes, keymaps, paredit, org-mode, Magit, SLY, CIDER, minibuffers, or user configuration matter.

## Mandatory operating loop

1. Discover instances with `emacs_instances`.
2. Open a session with `emacs_session_open`.
3. Use `emacs_read` for exact bounded source slices and `emacs_navigate` for deterministic point movement when command-loop semantics are not required.
4. Observe state before every mutating action.
5. Query adapter capabilities or active key bindings when a command is not certain.
6. Prefer `emacs_workflow` when an allowlisted repair/refactoring/Org transaction matches the task. These primitives own their buffer checkpoint, validation, verification, commit, and automatic buffer rollback.
7. Otherwise create a checkpoint for multi-step mutations and execute through the least risky channel that preserves required semantics.
8. Run `emacs_validate` after meaningful Lisp/Org edits and inspect machine-readable diagnostics.
9. Observe and verify runtime behavior.
10. Commit only after structural validation and task-level verification pass; otherwise repair or roll back.
11. Close the session when finished.

## Channel policy

- Prefer `semantic` for state queries, `emacs_read`, `emacs_navigate`, large text insertion, precise ranges, and known commands.
- Use `emacs_navigate` instead of keys for ordinary search, line/position movement, sexp traversal, and defun traversal. It works for background buffers and does not require a live window.
- Use `internal_keys` when current keymaps, interactive commands, minibuffers, transient maps, paredit, org-mode, or package-specific behavior must be preserved.
- Use `native_keys` only when the task explicitly requires real OS-level keyboard input or GUI behavior.
- Never use native input without confirming the target Emacs PID is frontmost.
- Treat `emacs_capture` and all OS-native operations as `trusted_local` capabilities.

## Safety rules

- Never mutate from stale state. Supply state or buffer tick preconditions.
- Never assume a key binding. Resolve it in the active target.
- Never send an incomplete synchronous minibuffer flow. Include prompt answers through completion.
- Stop when an unexpected minibuffer prompt appears.
- Arbitrary source-string Emacs Lisp execution is disabled in this build. Use only registered commands or buffer-derived structured evaluation operations.
- Do not save outside allowed workspace roots.
- Treat screenshots as sensitive and use them only when structured Emacs state is insufficient.
- Roll back when verification fails.

## High-level semantic transactions

Use `emacs_workflow` before manually orchestrating many low-level tools when one of its allowlisted operations fits:

- `repair_lisp`: applies one semantic edit, validates the Lisp buffer, optionally performs up to 8 buffer-derived evaluation steps, and commits only if all requested runtime checks pass.
- `refactor_defun`: resolves the enclosing defun from the Lisp adapter, replaces it atomically, validates it, and can perform bounded behavior checks. Prefer `expected_name`.
- `rename_symbol`: syntax-aware rename inside `current_defun` or the current `buffer`. It skips strings/comments and will not rename a prefix inside a larger Lisp symbol such as `foo/bar`. It is not a project-wide/xref rename.
- `extract_function`: extracts only complete buffer-derived Lisp forms from the current defun into a new function. Function names and parameters are constrained symbol tokens, existing function-name collisions are rejected, and optional definition loading/behavior verification requires `trusted_local`.
- `move_form`: moves a complete top-level form up/down without asking the model to calculate replacement ranges.
- `transform_sexp`: executes an allowlisted structural transform such as slurp/barf/splice/wrap/raise/split/join/indent through the Lisp structural adapter, then validates the buffer.
- `org_build_section`: creates a heading plus optional properties, body text, table, and source block. Optional Babel execution remains `trusted_local`, buffer-derived, and subject to Org evaluation policy.
- `org_rewrite_subtree`: rewrites selected current-heading metadata/body and can move the subtree while preserving property drawers and child subtrees. Use `expected_title` as an identity guard. Raw heading injection through `body` is rejected.

These are buffer transactions, not general runtime/database/filesystem transactions. When evaluation/Babel has run, inspect `transaction_scope`: buffer rollback is checkpoint-managed, while already-produced REPL, Babel, process, network, filesystem, or other runtime side effects may persist. Never claim full runtime rollback from `workflow.status=rolled_back`.

Do not emulate these workflows by sending arbitrary Lisp source for evaluation. Workflow evaluation steps are still restricted to code already present in the target buffer. Do not treat `status=rolled_back` as infrastructure failure; inspect `reason`, validation diagnostics, evaluation results, and `transaction_scope`, then propose a different edit.

## Lisp workflow

For Lisp editing:

1. Prefer the matching `emacs_workflow` primitive for bounded repair, whole-defun replacement, current-defun/buffer rename, buffer-derived extraction, top-level form movement, or structural sexp transforms. Use low-level calls when iterative discovery or exact interactive package semantics are required.
2. Call `emacs_capabilities` with adapter discovery and inspect the Lisp adapter before mutation.
3. Observe current defun, sexp bounds, parse depth, string/comment state, namespace/package state, and structural editing package state.
4. Prefer the semantic `emacs-operator-lisp-structural-edit` facade for slurp/barf/splice/wrap/raise/split/join/navigation. It resolves paredit, smartparens, or valid built-in fallbacks at runtime and makes mutating structural operations atomic.
5. Use `internal_keys` when the exact user's keymap/transient command-loop semantics are part of the task rather than merely the structural result.
6. After a structural or text edit, call `emacs_validate` with `adapter="lisp"`. Require `valid=true`; for Emacs Lisp also inspect reader diagnostics, not delimiter balance alone.
7. Use `emacs_eval` only with buffer-derived structured operations `eval_last_sexp`, `eval_defun`, or `eval_region`, under `trusted_local`. Never send arbitrary source strings.
8. Treat an evaluation result with `completed=false` as a repairable runtime diagnostic, not a transport failure. Inspect `condition`, `stderr`, `backtrace_handle`, and `metadata.source_bounds/source_sha256`, repair the buffer, validate again, reevaluate, then commit the checkpoint only after the expected value/behavior is observed.

## Org workflow

For Org editing:

1. Prefer `org_build_section` for constructing one bounded section and `org_rewrite_subtree` for guarded current-subtree title/tags/TODO/properties/body/movement changes; use low-level Org commands for more open-ended outline rearrangement or interactive package semantics.
2. Discover the Org adapter and observe heading path, level, subtree bounds, TODO, tags, properties, element context, and Babel context.
3. Prefer deterministic registered Org operations for heading insertion, promotion/demotion, movement, TODO/property/ID changes, and table cell/alignment/recalculation operations when they express the task exactly. For new documents, use `emacs-operator-org-create-heading`, `emacs-operator-org-insert-table`, and `emacs-operator-org-insert-src-block` instead of synthesizing Org syntax by hand.
4. For tables, observe `table.bounds`, `table.dimensions`, logical row/column and current cell before editing. Never align Org tables by inserting spaces manually.
5. Use `internal_keys` when transient maps, user keybindings, interactive prompts, or package-specific Org behavior are part of the requested semantics.
6. Use `emacs-operator-org-create-heading`, `emacs-operator-org-insert-table`, and `emacs-operator-org-insert-src-block` through safe noninteractive `emacs_command` when constructing document structure. Their JSON-friendly result is available as `execution.return_value`.
7. Call `emacs_validate` with `adapter="org"` after structural document changes. Inspect `document_summary` for bounded whole-document heading/table/source-block counts and positions instead of validating only the element at point.
8. Inspect `adapter_verification` after mutation and verify the outline tree, property drawer, table, and Babel context as applicable.
9. Execute Babel only through structured `emacs_eval` with `operation="execute_babel"` under `trusted_local`. The current buffer block is the only permitted source. Org `:eval no`/`:eval never` policy remains authoritative; a confirmation-only `query` is satisfied by the explicit `trusted_local` session.

## Native input workflow

1. Observe target and expected key binding.
2. Acquire the native desktop lease.
3. Focus the exact Emacs process and window.
4. Verify frontmost PID.
5. Send the key sequence.
6. Verify through the Emacs bridge command log or state change.
7. Restore the previous frontmost application when requested.
8. Release the lease.

## References

Read the project design specification and the files in `references/` when implementing or debugging this skill.

## Runtime availability policy

- Never treat a historical acceptance result as proof that the current machine has GNU Emacs or a package runtime.
- Use the validated GNU Emacs resolver. If no GNU Emacs 29+ binary is available, report real-Emacs gates as `not_run` unless the user/CI made them mandatory.
- A project-private runtime may be provisioned from a SHA-256 locked local Debian package set. Do not silently alter the system package manager or download unpinned runtime dependencies.
- Paredit, CIDER, and SLY source presence or `featurep` capability is not runtime acceptance. Require the package-specific behavioral gate.
- CIDER and SLY verification requires a real nREPL/Slynk connection. Never substitute a fake REPL to turn a package gate green.
