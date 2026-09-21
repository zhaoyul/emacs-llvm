# Testing

## Portable automated checks

Run these on every development platform:

```bash
npm run check:elisp-structure
npm run typecheck
npm run test:ts
swift test --package-path apps/macos-host
```

- TypeScript uses Node's built-in test runner.
- Tests cover protocol framing, Bridge discovery/authentication, MCP negotiation, sessions/policy, structured adapter evaluation/validation, safe noninteractive return values, Org Babel routing, semantic Lisp facade routing, native-driver discovery/authentication, native event routing, capture-file confinement, MCP image results and the fake-Emacs end-to-end path.
- `check-elisp-structure.py` is only a lightweight lexical delimiter/string/comment sanity check for constrained environments. It never substitutes for GNU Emacs byte compilation or ERT.
- Swift Testing covers platform-neutral framing, runtime records, secure token shape and capture-store cleanup.
- Linux Swift builds exercise non-macOS driver behavior; the macOS CI job is responsible for compiling/linking AppKit, ApplicationServices, CoreGraphics and ScreenCaptureKit source.

## GNU Emacs tests

On a machine with GNU Emacs 29+:

```bash
npm run test:elisp
```

ERT source covers the Bridge core, adapters and workflows, including:

- stable handles and observation;
- internal key execution;
- Org heading/property semantic workflows;
- Lisp structural adapter behavior;
- buffer-derived structured evaluation;
- `eval_region`;
- Org table observation and semantic cell editing;
- current-block Org Babel execution;
- source-string rejection;
- Org Babel `:eval never` rejection;
- optional paredit workflow when paredit is installed;
- Lisp validator delimiter/reader diagnostics;
- Emacs Lisp runtime errors returned as structured repair data with source metadata;
- safe noninteractive semantic-command return values;
- Org heading/table/source-block construction and bounded whole-document structural summaries;
- the 256 KiB buffer-derived Lisp evaluation limit;
- one-shot trusted execution of Org `:eval query` without an interactive prompt, while `no`/`never` remain denied.

SLY/CIDER runtime acceptance additionally requires their package and a live language runtime/nREPL/Slynk connection.

## Required real-environment acceptance

Mocks are not sufficient for these gates:

1. GNU Emacs 29+ must load the package and pass ERT.
2. Real paredit/smartparens and org-mode workflows must pass adapter verification.
3. CIDER and SLY must return structured results against live runtimes when those adapters are in scope.
4. A macOS runner must compile/link AppKit, ApplicationServices, CoreGraphics and ScreenCaptureKit sources.
5. Accessibility permission must be granted to the stable Host app bundle.
6. A native sequence must start with another app frontmost, focus Emacs, inject a real chord, and have the Bridge observe the expected command.
7. Human keyboard intervention must abort injection and release synthetic modifiers.
8. Screen Recording permission must allow capture of the selected Emacs window, and denial must produce `E_SCREEN_CAPTURE_NOT_GRANTED`.
9. Multiple graphical Emacs frames must resolve to the intended native window for both input and capture.

The concrete macOS procedure is in `docs/macos-acceptance.md`.


## Task-level workflow acceptance

With a live Bridge, run:

```bash
EMACS_OPERATOR_WORKFLOW_ACCEPTANCE_REPORT=dist/acceptance/workflow-acceptance.json \
  npm run accept:workflows
```

This suite intentionally measures complete outcomes rather than individual methods. The Lisp scenario creates both structural and runtime failures, requires machine-readable diagnosis, uses checkpoints for repair/rollback, validates the repaired buffer, re-evaluates the function and verifies the final value before commit. The Org scenario builds a heading tree, table and Babel block through semantic constructors, executes the block, validates the resulting document, verifies required structure/content and commits only after success.

`npm run accept:macos` invokes this workflow suite between real-Emacs semantic acceptance and native CGEvent/capture acceptance.
