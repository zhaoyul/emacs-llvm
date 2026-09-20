# Emacs Operator 0.1.0-alpha.8

Alpha.8 adds bounded Emacs-native refactoring primitives above the alpha.7 semantic buffer transaction layer.

## Added

- `emacs_workflow(operation="rename_symbol")` for syntax-aware current-defun or current-buffer rename.
- `emacs_workflow(operation="extract_function")` for buffer-derived complete-form extraction from the current defun.
- `emacs_workflow(operation="move_form")` for complete top-level Lisp form movement.
- `emacs_workflow(operation="transform_sexp")` for allowlisted structural transformations through paredit, smartparens, or valid built-in fallbacks.
- `emacs_workflow(operation="org_rewrite_subtree")` for guarded current-heading metadata/body changes while preserving child hierarchy.
- optional `expected_name` identity guards for current-defun rename and function extraction.
- `transaction_scope` on workflow outcomes, explicitly distinguishing checkpoint-managed buffer state from non-transactional runtime evaluation effects.
- `docs/refactoring-workflows.md` with precise scope and deferred capabilities.
- live alpha.8 refactoring gates in `accept:workflows`.

## Lisp refactoring safeguards

`rename_symbol`:

- skips strings and comments;
- matches whole Lisp symbol tokens;
- does not rename `foo` inside `foo/bar`;
- is bounded to `current_defun` or current `buffer`;
- does not claim project/xref/LSP rename semantics.

`extract_function`:

- accepts only source ranges inside the current defun;
- requires the range to consist of complete Lisp forms;
- caps the extracted source at 256 KiB;
- derives function body only from the target buffer;
- constrains generated function/parameter symbols;
- rejects duplicate parameters;
- rejects existing source definitions and, for Emacs Lisp, an already-bound runtime function name;
- tracks generated definition bounds with markers so indentation cannot stale the returned coordinates;
- optionally loads the definition and performs up to 8 existing buffer-derived behavior checks under `trusted_local`.

## Org rewrite safeguards

- title and tag changes use Org APIs;
- tag tokens reject colon/whitespace syntax injection;
- property values are single-line and bounded;
- section-body rewrite preserves planning/metadata, property drawers, and child subtrees;
- raw Org heading lines in replacement body are rejected;
- `expected_title` can reject target drift before mutation.

## Transaction semantics clarified

The high-level workflow layer coordinates **buffer** transactions. It does not promise rollback of arbitrary runtime effects.

When Lisp/REPL/Babel evaluation has occurred, outcomes expose:

```json
{
  "transaction_scope": {
    "buffer": "checkpoint_managed",
    "runtime": "not_transactional"
  }
}
```

A later buffer rollback can restore source text while a loaded function definition, Babel side effect, process, file write, network operation, or other runtime effect remains. Agent instructions now require callers to preserve this distinction.

## Acceptance target

Portable TypeScript, Swift and lexical Elisp checks run in the implementation container. Authoritative ERT, real paredit/Org/CIDER/SLY behavior, Accessibility, CGEvent and ScreenCaptureKit acceptance still require GNU Emacs 29+ on a real Mac.

Run:

```bash
npm run accept:macos
```

on the target Mac.
