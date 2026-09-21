# Benchmarking Emacs Operator

## Purpose

Alpha.11 adds an evaluation subsystem for the original product question:

> Does giving the same LLM Emacs-native structural editing, mode semantics, REPL feedback, and guarded transactions improve Lisp and Org task performance compared with ordinary filesystem/shell editing?

The benchmark can measure evidence for a specific suite, model configuration, prompt policy, tool contrast, machine, and sample. It cannot establish a universal advantage from one run.

The benchmark package is development and evaluation infrastructure. It is intentionally excluded from the runtime MCPB bundle.

## Architecture

```text
versioned suite
  + prompt
  + fresh fixture
  + hidden checks/verifiers
          |
          v
isolated trial workspace
          |
          v
Agent command, JSON over stdin/stdout
          |
          +-- edits workspace
          +-- emits optional sanitized trace
          |
          v
independent scorer
  + file and structure checks
  + protected/allowed path gates
  + optional runtime verifier in disposable copy
          |
          v
immutable JSON report
          |
          v
paired comparison with stable trial_seed
```

The request sent to the Agent contains the task prompt, workspace, suite/task fingerprints, trial number, and `trial_seed`. It does not contain checks, expected files, verifier paths, protected path declarations, or allowed path declarations.

## What is implemented

- Versioned JSON suite, request/result, report, comparison, profile, and experiment schemas.
- Fresh fixture copy for every task trial.
- SHA-256 fingerprints for suites, prompts, fixtures, tasks, reports, and Agent profiles.
- Stable `trial_seed` derived from suite digest, task id, trial, and run seed.
- Exact one-object JSON stdio protocol for external Agent wrappers.
- Independent file, text, Lisp delimiter, Org structure, and command verifiers.
- Hard gates for protected paths and files outside `allowed_paths`.
- Command checks disabled unless `--allow-command-checks` is explicit.
- Command checks run in a disposable copy of the final workspace.
- Bounded JSONL trace collection and Emacs Operator audit-to-trace conversion.
- Paired baseline/candidate reports with deterministic bootstrap confidence interval.
- Agent profiles that record model controls and reject secret-shaped fields.
- A controlled paired-run launcher that requires the same model controls while allowing the tool profile to differ.
- A portable deterministic sensitivity suite that proves the harness detects five encoded failure modes.
- A behavior-oriented Lisp/Org suite with runtime verifiers for Emacs Lisp, Clojure, Common Lisp, and Org/Babel.

## Security and isolation boundary

This harness is not an operating-system sandbox.

`CommandAgent` launches the configured command as the current user. Excluding verifier data from the JSON request is a cooperative experimental control, not an adversarial secrecy guarantee. A process with broad filesystem access may discover repository files. For publishable or hostile-code experiments, run each Agent and each verifier in a container, VM, sandboxed account, or disposable host that exposes only the intended workspace and required runtime.

Runtime command checks can execute code produced by the Agent. They are disabled by default and must be reviewed before enabling. The scorer creates a disposable copy of the final workspace for each command check, which prevents verifier writes from contaminating the scored workspace. It does not stop network access, writes to absolute external paths, subprocess creation, or other host side effects.

Never put API keys, passwords, tokens, credentials, or private keys into Agent profile JSON. The profile loader rejects secret-shaped field names, but the experiment operator remains responsible for secret management outside reports.

## Suites

### `benchmarks/harness-sensitivity-v1`

This suite is a deterministic release probe. It compares an intentionally naive text transformer with a deterministic semantic reference implementation. The expected result is:

```text
naive text implementation:       0 / 5 tasks passed
semantic reference implementation: 5 / 5 tasks passed
```

That split demonstrates that the checks detect collateral symbol edits, package/namespace damage, delimiter damage, and malformed Org structure. It is not an LLM comparison.

Run it with:

```bash
npm run benchmark:sensitivity
```

### `benchmarks/lisp-org-v1`

This suite currently contains eight behavior-oriented tasks:

1. Repair zero-safe Emacs Lisp division.
2. Rename an Emacs Lisp symbol without touching strings, comments, or qualified symbols.
3. Extract a behavior-preserving Emacs Lisp helper.
4. Rename a Clojure var while preserving namespace/alias semantics.
5. Rename an exported Common Lisp symbol while preserving package semantics.
6. Build an Org hierarchy with properties, table, Babel block, and result.
7. Rewrite one Org subtree while preserving descendants and siblings.
8. Correct an Org table and recalculate the existing Babel result.

The runtime verifiers require `emacs`, `clojure`, or `sbcl`, depending on the task. Missing runtimes make a task unavailable. An unavailable task is never counted as a pass.

Validate both suites and the checked-in Agent profiles without executing tasks:

```bash
npm run benchmark:validate
```

Inspect which real tasks can run on the current machine:

```bash
npm run benchmark:preflight
```

Preflight reports missing `emacs`, `clojure`, `sbcl`, platform, or required environment variables as explicit unavailable reasons. It never converts an unavailable task into a pass.

## Agent command protocol

The harness writes one JSON object to stdin. Important request fields include:

```json
{
  "protocol_version": "1.0",
  "suite_digest": "...",
  "task_digest": "...",
  "trial": 1,
  "trial_seed": 1234567890,
  "prompt": "...",
  "workspace": "/private/trial/workspace",
  "trace_path": "/private/trial/workspace/.emacs-operator-benchmark/trace.jsonl",
  "timeout_ms": 180000
}
```

The wrapper must emit exactly one result object on stdout:

```json
{
  "protocol_version": "1.0",
  "status": "completed",
  "summary": "Task completed.",
  "usage": {
    "input_tokens": 1000,
    "output_tokens": 200,
    "tool_calls": 12,
    "mutations": 3,
    "rollbacks": 1
  }
}
```

Write logs to stderr, not stdout. `examples/benchmark-agent.example.mjs` is a safe protocol template and intentionally returns `refused` until connected to a real Agent.

A wrapper should use `trial_seed` whenever its provider or Agent supports deterministic seeding. The same suite and run seed produce the same per-task/per-trial seed for both baseline and candidate, independent of run id and execution order.

## Agent profiles

Profiles record the controls needed to interpret a paired experiment:

```json
{
  "schema_version": "1.0",
  "id": "filesystem-baseline",
  "revision": "experiment-2026-08-31",
  "label": "Same-model filesystem baseline",
  "kind": "llm_experiment",
  "pairing_key": "model-snapshot-and-prompt-policy-001",
  "provider": "provider",
  "model": "model-name",
  "model_version": "snapshot-or-date",
  "tool_profile": "filesystem-shell-without-emacs-operator",
  "prompt_policy": "lisp-org-v1-identical-task-prompts",
  "temperature": 0,
  "top_p": 1,
  "max_context_tokens": 128000,
  "cross_trial_memory": "disabled",
  "network_access": "disabled"
}
```

Use the templates in `benchmarks/profiles/`. The paired launcher requires both profiles to share `pairing_key`, provider, model, model version, prompt policy, sampling controls, context budget, memory policy, and network policy. Their `tool_profile` values must differ.

Validate a profile:

```bash
npm run benchmark -- profile-validate \
  --profile benchmarks/profiles/filesystem-baseline.example.json
```

## Running one Agent

Build the project first, then invoke the Agent wrapper as a JSON command array:

```bash
npm run benchmark -- run \
  --suite benchmarks/lisp-org-v1/suite.json \
  --agent-id filesystem-baseline \
  --agent-version model-snapshot \
  --agent-profile benchmarks/profiles/filesystem-baseline.example.json \
  --agent-command-json '["node","/absolute/path/to/filesystem-agent-wrapper.mjs"]' \
  --allow-command-checks \
  --require-all \
  --trials 3 \
  --seed 17 \
  --output artifacts/filesystem-baseline.json
```

`--require-all` makes missing task runtimes a report error. Omit it during partial local smoke tests. `--preserve-workspaces` retains trial workspaces for diagnosis; it should normally be off for repeatable clean experiments.

## Running a controlled pair

Use the paired launcher rather than manually mixing reports:

```bash
npm run build
node scripts/run-benchmark-pair.mjs \
  --suite benchmarks/lisp-org-v1/suite.json \
  --baseline-profile /path/to/filesystem-baseline.json \
  --candidate-profile /path/to/emacs-operator.json \
  --baseline-command-json '["node","/absolute/path/to/baseline-wrapper.mjs"]' \
  --candidate-command-json '["node","/absolute/path/to/candidate-wrapper.mjs"]' \
  --output-dir artifacts/paired-experiment-001 \
  --allow-command-checks \
  --require-all \
  --trials 10 \
  --seed 17
```

The launcher validates profile pairing, records execution order, runs both sides with the same suite digest and run seed, writes `baseline.json`, `candidate.json`, `comparison.json`, and `experiment.json`, and refuses to compare different run-level seeds.

For stronger order control, repeat the whole paired experiment with several predeclared run seeds. The launcher reverses side order based on seed parity and records the order. Do not choose seeds after seeing results.

## Fair comparison protocol

A credible filesystem-vs-Emacs Operator experiment should hold these constant:

- Exact model and model snapshot.
- System/developer prompt and task prompt policy.
- Sampling controls and context budget.
- Time and token budget.
- Wrapper implementation and retry policy.
- Network policy and cross-trial memory policy.
- Ordinary filesystem/shell capabilities, unless the planned contrast explicitly changes them.
- Suite revision, command-verifier policy, run seed, and number of trials.

The intended contrast is the tool profile:

```text
baseline:  filesystem/shell editing without Emacs Operator
candidate: equivalent baseline tools plus Emacs Operator semantic/internal/native channels
```

A benchmark in which the candidate receives a better model, larger context, additional hidden instructions, a warmer memory, or more retries does not isolate the effect of Emacs Operator.

## Scoring

The Agent's own `summary` and `status=completed` are never sufficient. A trial passes only when:

1. The Agent reports completion.
2. Every required independent check passes.
3. The weighted score meets the threshold.
4. No protected path was changed.
5. No path outside `allowed_paths` was changed.

Runtime verifiers are heavily weighted in the Lisp/Org suite, but structural checks remain useful diagnostics. Multiple correct source layouts are accepted when runtime behavior and required semantics agree.

Trace/token/tool metrics are observational telemetry. They can be self-reported or derived from Agent-produced trace data, so they should not be treated as adversarially trustworthy. Outcome checks and workspace hashes are the primary evidence.

## Comparison report

Paired outcome ordering is:

```text
pass beats fail
otherwise higher independent score wins
equal result is a tie
```

The report includes candidate wins, baseline wins, ties, paired pass rates, mean scores, paired advantage, and a deterministic bootstrap 95% interval. A positive interval applies only to the exact suite and experiment controls. An interval crossing zero is reported as inconclusive.

With very small samples, even a visually dramatic split is exploratory. Use the sensitivity suite only for harness validation. For Agent studies, predeclare tasks, profiles, seeds, exclusions, and stopping rules, then retain all reports, including failures.

## Extending the corpus

A task directory should contain:

```text
prompt.md
fixture/
verifier, expected output, or structural checks
```

Prefer behavior checks over exact formatting. Exact text is appropriate for harness probes or requirements where byte identity is itself the task. Declare every file the Agent may change in `allowed_paths`, and use protected files to detect collateral edits.

A command verifier should:

- Be deterministic and noninteractive.
- Use only the disposable workspace copy and suite-owned verifier code.
- Exit nonzero on failure.
- Emit a short stable success marker.
- Avoid network and external writes.
- Use explicit timeouts.
- Never delete or weaken checks based on Agent output.

Changing a prompt, fixture, check, or referenced verifier changes the task/suite digest. Keep the suite revision human-readable as well, and never compare reports with different digests.


## Language-aware project Rename coverage

Alpha.11 also extends the production refactoring path used by the benchmark tasks. Project Rename plans now carry `language`, `qualification_policy`, requested/effective symbol identity, and bounded symbol-semantics metadata.

- Clojure rename can preserve `namespace/name` qualification or apply an explicit `leaf_only` policy. Keywords, auto-resolved keywords, reader-sensitive names, and auto-gensyms are rejected unless a future reader-aware migration path handles them.
- Common Lisp rename preserves plain, `package:name`, and `package::name` identity. Package and external/internal visibility changes are rejected before Bridge mutation. Common Lisp identity comparison is case-normalized.

The portable tests prove plan and MCP routing behavior. Real backend quality still depends on the active xref/CIDER/SLY implementation and must be accepted on a genuine Emacs installation.
