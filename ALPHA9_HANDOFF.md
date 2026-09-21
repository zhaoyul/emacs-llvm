# Alpha.9 handoff

## Portable gate

```bash
npm run accept:alpha9
```

The command runs the standalone refactoring-intelligence tests, verifies static adapter markers, and runs the new ERT suite when GNU Emacs is installed. Missing Emacs is reported as `not_run`, never as a pass.

## Real macOS gate

```bash
npm run accept:macos
```

Run this on a Mac with GNU Emacs 29+, Accessibility authorization, Screen Recording authorization, paredit, Org, CIDER, and SLY. Review the analysis result before applying a project rename plan. The apply step edits unsaved buffers only.

## Focused runtime checks

1. `emacs_analyze` returns a normalized analysis object for `infer_extract_parameters`.
2. `unresolved` blocks automatic extract-function unless explicit parameters are supplied.
3. An xref rename plan is immutable and expires after its configured TTL.
4. Changing any planned file after planning makes apply fail before mutation.
5. Apply changes all target buffers and saves none of them.
6. REPL rerun stops for unknown side-effect risk and repeated source-hash/condition pairs.
