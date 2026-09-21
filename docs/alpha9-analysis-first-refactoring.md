# Alpha.9 Analysis-First Refactoring

## Purpose

Alpha.9 introduces an analysis-first layer above the alpha.8 buffer workflows. A potentially broad refactoring is split into two phases:

```text
observe -> analyze -> immutable plan -> preflight every target -> apply to buffers -> validate -> explicit save
```

The plan is deliberately not a bag of best-effort search results. It contains the project root, exact old/new symbols, per-file SHA-256 values, exact edit ranges, source text expectations, limits, and a content-derived `plan_id`. Any stale file, path escape, altered occurrence, expired plan, overlap, or integrity mismatch aborts before the first mutation.

## Conservative extract-function parameter inference

The Lisp analyzer returns:

```json
{
  "parameters": ["x", "y"],
  "unresolved": [],
  "confidence": "high",
  "source_sha256": "..."
}
```

Only variables proven to come from a visible outer binding are inferred. Strings, comments, keywords, qualified names, function-head positions, quoted data, globals, special forms, and bindings introduced inside the selected forms are excluded. Ambiguous names go to `unresolved`. The workflow must not silently promote unresolved names into parameters.

Recommended flow:

1. Read and navigate to complete forms.
2. Call `emacs_analyze` with adapter `lisp`, operation `infer_extract_parameters`, and exact bounds.
3. Require `unresolved` to be empty, or provide an explicit reviewed parameter list.
4. Include the returned source hash in the mutation request to detect drift.
5. Run Lisp validation before evaluation.

## Xref-backed project rename

The Emacs implementation exposes two commands:

```text
emacs-operator-project-rename-plan
emacs-operator-project-rename-apply
```

Planning uses the active xref backend, limits results to the current local project, skips remote paths, canonicalizes files, resolves each xref marker to an exact Lisp symbol occurrence, and stores a short-lived plan. Applying preflights every buffer before activating any change group. Edits are applied from high to low positions and remain unsaved.

This is a buffer-set transaction, not a filesystem or runtime transaction. Saving files is explicit. Previously executed REPL or Babel side effects cannot be rolled back by restoring buffers.

## Controlled REPL rerun

A failed evaluation is rerunnable only when all of the following hold:

- The maximum is between one and three attempts.
- Source changed after the previous failure.
- The same source hash and condition are not repeating.
- Runtime side-effect risk is low, or the caller explicitly authorizes the risk.
- A completed result stops immediately.

Unknown side-effect risk defaults to stop. This is intentionally less convenient than a blind retry loop and much safer.

## Compatibility normalization

The integration helper accepts both historical Bridge analysis shapes:

```json
{"analysis": {"parameters": ["x"]}}
```

and:

```json
{"parameters": ["x"]}
```

The MCP-facing result is normalized to the inner analysis object.

## Current integration status

- Lisp module loaded: `True`.
- Lisp analyzer registered in the detected adapter registry: `True`.
- MCP analysis response normalizer detected: `False`.
- Project plan/apply implementation present: `True`.
- Exact command-policy entries detected: `False`.

A false item means the source module is present but that repository-specific integration point requires runtime acceptance or a small manual adapter hook. It must not be advertised as verified merely because the standalone planner tests pass.
