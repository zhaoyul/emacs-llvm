# Lisp and Org Workflow Acceptance

Alpha.6 adds `npm run accept:workflows` to test complete agent behavior against a live GNU Emacs Bridge. The runner uses only temporary fixture files and removes them after the run. It does not modify user project files.

## Run

```bash
EMACS_OPERATOR_WORKFLOW_ACCEPTANCE_REPORT=dist/acceptance/workflow-acceptance.json \
  npm run accept:workflows
```

Use `EMACS_OPERATOR_ACCEPTANCE_INSTANCE_ID=<instance-id>` when more than one live Bridge is available. The selected Emacs instance must have Emacs Operator loaded.

## Lisp repair loop

The runner opens a temporary Emacs Lisp buffer in a `trusted_local` session and verifies the following sequence:

1. Create a checkpoint.
2. Deliberately remove a closing delimiter.
3. Run `emacs_validate` with the Lisp adapter and require `valid=false` plus a repairable diagnostic position/context.
4. Roll back and require a valid structure.
5. Evaluate a deliberately broken defun and reproduce a language-level runtime condition through `emacs_eval`.
6. Create a repair checkpoint and edit the faulty expression.
7. Require structural validation to pass.
8. Re-evaluate the repaired defun and a representative call.
9. Require the call value to be `5`.
10. Commit the repair checkpoint.

The workflow distinguishes structural failure from runtime failure. Structural invalidity comes from `emacs_validate`; program conditions come from structured evaluation with `completed=false`. Bridge/MCP failures remain tool errors.

## Org build loop

The runner starts with an empty temporary Org buffer and uses registered semantic commands to construct the document:

1. Create `Project` and `Data` headings.
2. Insert a two-column Org table with two data rows.
3. Update the second row value through `org-table-put` via the semantic table API.
4. Create a `Computation` heading.
5. Insert an `emacs-lisp` Babel source block through the structured source-block constructor.
6. Validate the document before evaluation.
7. Execute only the current source block through `emacs_eval` under `trusted_local`.
8. Require value `42` and result insertion.
9. Validate the result-bearing document again.
10. Commit the document checkpoint.

## Reports and failure behavior

The JSON report uses the same `pass`/`fail` gate style as the other acceptance runners. A fatal error outside a named gate is recorded as a failed `workflow runtime` gate before the process exits nonzero. This makes the report safe for another LLM agent to consume without scraping console logs.

`npm run accept:macos` invokes this suite automatically after `accept:emacs-runtime` and before native keyboard/capture acceptance.
