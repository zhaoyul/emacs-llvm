# Emacs Operator 0.1.0-alpha.9

## Theme

Alpha.9 adds analysis-first Lisp refactoring: conservative extract-function parameter inference, immutable two-phase project rename plans, and bounded REPL rerun policy.

## Added

- `@emacs-operator/refactor-intelligence`, a dependency-free planner and policy package.
- Syntax-aware Lisp scanner that ignores strings, line comments, nested block comments, and exact symbol-boundary mismatches.
- Conservative free-variable analysis with explicit `unresolved` output.
- Content-addressed project rename plans with per-file SHA-256 preconditions.
- In-memory and filesystem plan application with full preflight and bounded rollback.
- Emacs xref-backed `project-rename-plan` and unsaved buffer-set `project-rename-apply`.
- Analysis response compatibility normalization.
- Bounded verification rerun controller, maximum three attempts.
- JSON Schemas for analysis results, rename plans, and rerun policy.
- ERT source for parameter inference and symbol validation.

## Safety boundaries

- No project mutation occurs during planning.
- No file outside the canonical project root is accepted.
- Remote files and symlink escapes are rejected by the standalone filesystem planner.
- Every file and occurrence is revalidated before apply.
- Emacs apply modifies buffers but does not save them.
- Ambiguous extract parameters stop automatic extraction.
- Unknown or high side-effect risk stops automatic REPL rerun by default.
- Buffer rollback does not claim to undo runtime, network, process, database, or filesystem side effects.

## Portable validation from this environment

- Alpha.9 planner tests: `PASS`.
- Node syntax checks: `see emacs-operator-alpha9-validation.json`.
- Repository TypeScript typecheck: `PASS`.
- Repository tests: `PASS`.
- Swift portable tests: `NOT RUN`.
- New Elisp structural scan: `FAIL (exit 1)`.
- GNU Emacs ERT: `NOT RUN: GNU Emacs unavailable`.

`alpha9_core_ok=False` and `portable_ok=False`. Full GNU Emacs, xref backend, CIDER, SLY, and macOS native input acceptance remain authoritative runtime gates.
