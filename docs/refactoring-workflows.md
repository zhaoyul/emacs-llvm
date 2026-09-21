# Refactoring Workflows

This document defines the bounded refactoring semantics introduced in `0.1.0-alpha.8`.

The goal is not to pretend that a text editor RPC has become a whole-program compiler refactoring engine. The goal is to give an LLM agent a small set of high-confidence, Emacs-native structural transformations that avoid fragile hand-calculated text ranges and that can be validated before a buffer commit.

## Transaction boundary

`emacs_workflow` is a **buffer transaction coordinator**.

For every mutating workflow it owns a checkpoint, runs the allowlisted mutation, validates the resulting Lisp/Org structure, performs requested behavior checks, and commits or rolls back the buffer.

When evaluation has already executed, runtime effects are not generally reversible. A result therefore includes `transaction_scope`:

```json
{
  "buffer": "checkpoint_managed",
  "runtime": "not_transactional",
  "warning": "Buffer rollback does not guarantee reversal of Lisp REPL, Babel, filesystem, process, network, or other runtime side effects already produced by evaluation."
}
```

A rolled-back buffer must never be described as a full runtime rollback.

## `rename_symbol`

Scope is deliberately limited to:

- `current_defun`
- current `buffer`

The adapter searches exact symbol tokens using the active Lisp syntax table and skips strings/comments. A rename of `foo` does not rename the `foo` prefix inside `foo/bar`.

Optional `expected_name` is valid with `scope=current_defun` and guards the refactoring against point/context drift.

This operation is **not**:

- project-wide rename;
- namespace-aware reference resolution;
- xref/LSP rename;
- macro-expansion-aware semantic rename.

Project-wide rename should be added later as a separate primitive backed by language-specific reference discovery, never by silently widening this operation.

## `extract_function`

The extraction range must:

- be inside the current defun;
- contain only complete Lisp forms;
- be at most 256 KiB;
- come from the target buffer.

The caller provides a new function name and zero or more simple parameter symbols. The generated call uses the same parameter symbols as arguments. Caller-supplied arbitrary function bodies or call expressions are not accepted.

Before mutation the Lisp adapter rejects:

- source-level function-name collisions;
- existing Emacs Lisp runtime function bindings for the proposed new name;
- duplicate parameter names;
- generated symbol tokens that could introduce reader/package/binding syntax;
- qualified Clojure names in generated binding positions.

`expected_name` can guard the enclosing source defun.

When `evaluate_definition=true`, loading the new definition requires `trusted_local`. Subsequent behavior checks may contain up to eight buffer-derived evaluation steps. Runtime loading/evaluation is intentionally reported as non-transactional.

## `move_form`

Moves the complete top-level Lisp form containing point across the adjacent complete top-level form.

Supported directions:

- `up`
- `down`
- `backward`
- `forward`

The adapter resolves forms with the Lisp reader/scanner rather than asking the model to calculate replacement offsets. Delimiter balance is checked before and after each movement.

This primitive preserves raw separator text between the two forms. It does not claim semantic ownership of comments in that separator. Agents should inspect the result when comments encode important adjacency semantics.

## `transform_sexp`

Routes an allowlisted structural operation through the Lisp structural facade:

- `slurp_forward`
- `barf_forward`
- `splice`
- `wrap_round`
- `raise`
- `split`
- `join`
- `indent_defun`

At runtime the facade resolves paredit first when active/available, then smartparens, then a valid built-in fallback where one exists. Mutating transformations are atomic and must preserve delimiter balance.

Use `internal_keys` instead when the exact user keymap, transient map, interactive prompt flow, or package command-loop behavior is itself part of the requirement.

## `org_rewrite_subtree`

Despite its workflow name, this primitive intentionally does not replace a raw subtree string. It can update selected attributes of the current heading:

- title;
- TODO state;
- tags;
- properties;
- section body;
- subtree position up/down.

`expected_title` provides an identity guard before mutation.

Section-body replacement preserves:

- the heading line;
- planning/metadata handled by Org;
- property drawers;
- child subtrees.

Raw heading lines inside the replacement body are rejected. New child hierarchy must be created with structured heading operations.

Tags are constrained tokens and property values are bounded single-line strings, preventing tag/property syntax injection through this semantic API.

## Verification pattern

Recommended Lisp refactor flow:

```text
observe / navigate
  -> emacs_workflow(refactoring primitive)
     -> checkpoint
     -> structural mutation
     -> emacs_validate(adapter=lisp)
     -> optional buffer-derived evaluation(s)
     -> commit | automatic buffer rollback
  -> independent observe/read when task risk warrants it
```

Recommended Org rewrite flow:

```text
adapter_observe
  -> verify expected_title
  -> emacs_workflow(org_rewrite_subtree)
     -> checkpoint
     -> Org semantic commands
     -> emacs_validate(adapter=org)
     -> commit | automatic buffer rollback
  -> inspect bounded document_summary
```

## Deferred refactoring work

Candidate later primitives should be explicit rather than hidden behind broader behavior in alpha.8:

- project/xref-aware rename;
- extract-function free-variable analysis and automatic parameter inference;
- inline function;
- let/expression extraction;
- macro-aware move/refactor;
- CIDER/SLY-specific namespace/package refactorings;
- best-effort restoration of prior runtime function definitions after failed behavior verification;
- multi-buffer/multi-file transactional refactoring.
