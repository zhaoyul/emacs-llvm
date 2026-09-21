# Emacs Operator 0.1.0-alpha.7

Alpha.7 introduces high-level semantic transactions without weakening the lower-level Emacs-native execution model.

## Added

- `emacs_workflow` MCP tool.
- `repair_lisp`, `refactor_defun`, and `org_build_section`.
- coordinator-owned checkpoint/commit/automatic rollback.
- 1-8 buffer-derived Lisp evaluation steps per transaction.
- per-step deterministic navigation and expected-value verification.
- adapter-resolved whole-defun bounds and optional `expected_name` identity guard.
- structured rollback outcomes that separate proposal failure from infrastructure failure.
- detailed MCP schemas for workflow edit/evaluation/navigation/Org-section fields.
- fake-Bridge transaction integration tests.
- live alpha.7 high-level Lisp and Org gates in `accept:workflows`.

## Preserved security boundaries

- no arbitrary caller-provided Elisp/source-string evaluation;
- workflow evaluation source is target-buffer derived and bounded;
- structured evaluation requires `trusted_local`;
- Org Babel still respects explicit `:eval no`/`:eval never`;
- nested workspace/policy/stale-state checks remain active;
- rollback failure is promoted to an infrastructure error.

## Acceptance target

Portable checks can run in the implementation container. Authoritative ERT, real paredit/Org/CIDER/SLY behavior, Accessibility, CGEvent and ScreenCaptureKit acceptance still require GNU Emacs 29+ on a real Mac. Run `npm run accept:macos` there.
