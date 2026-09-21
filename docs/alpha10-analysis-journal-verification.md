# Alpha.10: Analysis, rename journals, and guarded verification

## 1. Analysis is a first-class read-only channel

`emacs_analyze` dispatches to an applicable adapter through `adapter.analyze`. The Bridge records `buffer-chars-modified-tick` and `buffer-modified-p` before and after the analyzer. If either changes, the call fails. Analysis therefore cannot quietly become an edit channel.

The Lisp analyzer currently supports:

- `infer_extract_parameters`
- `evaluation_source_fingerprint`

### Extract-function inference

When `emacs_workflow(operation="extract_function")` omits `parameters`, the workflow performs `infer_extract_parameters` before it creates a checkpoint.

The analyzer returns proven-visible parameter names separately from unresolved value-position symbols. It considers current defun/lambda parameters and conservative enclosing lexical bindings, skips strings/comments/quoted forms/function heads, and does not turn unknown names into parameters automatically.

If `unresolved` is non-empty, the workflow returns `E_ANALYSIS_UNRESOLVED` before mutation. The caller can narrow the selection or provide explicitly reviewed parameters.

## 2. Project rename lifecycle

Use `emacs_project_rename` rather than emulating project rename through global text replacement.

Recommended sequence:

```text
plan
  -> preview
  -> review
  -> apply
  -> status
  -> validate / compile / test
       -> commit
       -> rollback
```

### Plan

The Emacs implementation asks the active xref backend for definitions/references, resolves exact symbols, excludes comments/strings, confines files to the active local project root, and stores hashes plus exact edit coordinates. Plan size and TTL are bounded.

### Preview

Preview validates that source hashes still match the plan and returns a bounded list of before/after source lines. It does not mutate buffers.

### Apply

Every target is preflighted before the first edit. The operation creates Emacs change groups, applies edits from higher coordinates to lower coordinates, builds and hashes the rollback journal while those change groups are still active, and only then accepts the groups. A journal-construction error can therefore still cancel the active groups instead of leaving accepted edits without a journal. Files are not saved.

### Status

`action="status"` returns journal metadata only:

- journal/plan id
- project root
- created/expires timestamps
- file/buffer identity
- original and applied SHA-256 values
- original modified flag

The retained `original_text` snapshots are intentionally not returned to the model.

### Rollback

Rollback checks each current buffer hash against the applied hash and verifies visited-file modtime before it touches any buffer. A later user edit or on-disk change therefore stops rollback instead of being overwritten.

### Commit

Commit only removes the rollback journal. Saving remains a separate explicit action.

## 3. Guarded structured verification

`emacs_verification` manages a session-bound ticket around buffer-derived structured evaluation.

Actions:

- `start`
- `rerun`
- `status`
- `close`

Allowed evaluation operations remain:

- `eval_last_sexp`
- `eval_defun`
- `eval_region`

Caller-supplied source strings remain disabled.

A failed first attempt stores condition/result metadata plus a buffer-derived source fingerprint and locator (`source_start` / `source_bounds`). `rerun` first obtains a fresh read-only fingerprint. The target start must still identify the same structured evaluation target, and the source hash must have changed. If point or region now selects a different target, rerun stops with `source_target_changed`. If the same target is unchanged, rerun stops with `source_unchanged`.

Reruns also stop when:

- maximum attempts are reached
- the previous evaluation completed
- source fingerprint or target locator is unavailable
- the structured evaluation target changed (`source_target_changed`)
- side-effect risk is `high` or `unknown` without explicit `allow_risky_rerun`

This prevents an agent from repeatedly executing the same failing REPL form merely because it has no better repair proposal.

## 4. Safety boundary

Analysis, planning, preview and journal inspection are read-only operations. Apply/rollback require a mutating profile. Structured evaluation requires `trusted_local`.

Buffer rollback is not runtime rollback. A successfully executed REPL form can already have mutated external state. Side-effect risk must therefore be assessed before any automated rerun.

## 5. Acceptance

Portable release gate:

```bash
npm run accept:alpha10
```

Full macOS + real Emacs gate:

```bash
npm run accept:macos
```

On macOS, the workflow acceptance suite also exercises alpha.10 parameter inference against a real Emacs Lisp buffer before extraction.
