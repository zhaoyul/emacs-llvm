# Lisp and Org semantic benchmark v1

This suite compares Agents on the same prompts, fresh fixture workspaces, and independent behavior checks. It intentionally allows multiple correct implementations. The Agent request contains the prompt and workspace path, but not the checks, verifier source, protected-path rules, or expected outputs.

The suite contains eight tasks covering Emacs Lisp repair/refactoring, Clojure namespace-aware rename, Common Lisp package-aware rename, and Org hierarchy/table/Babel authoring. Runtime verifiers are authoritative for the language tasks. A missing required executable makes a task unavailable or skipped; it never turns the task into a pass.

## Validate the corpus

```bash
npm run benchmark:validate
```

Validation proves that the suite schema, fixture paths, limits, and digests are internally consistent. It does not execute the language tasks and does not measure an Agent.

## Run one Agent

Build the benchmark package first, then provide a protocol-compatible Agent wrapper:

```bash
npm run build
node dist/packages/benchmark/src/cli.js run \
  --suite benchmarks/lisp-org-v1/suite.json \
  --agent-id filesystem-baseline \
  --agent-profile benchmarks/profiles/filesystem-baseline.example.json \
  --agent-command-json '["/absolute/path/to/filesystem-agent-wrapper"]' \
  --allow-command-checks \
  --trials 3 \
  --seed 11 \
  --output artifacts/filesystem-baseline.json
```

`examples/benchmark-agent.example.mjs` is only a safe protocol template. It deliberately returns `refused` and therefore is not a meaningful benchmark Agent. Copy it when implementing a real wrapper, but do not cite its output as an Agent result.

Command checks are disabled by default. Review every verifier and run inside an isolated container, VM, or dedicated low-privilege account before enabling `--allow-command-checks`. The harness uses a disposable verifier workspace copy, but it is not an operating-system sandbox.

## Run a controlled pair

Use the paired launcher so both reports share the exact suite digest, run seed, trial count, and derived per-task `trial_seed` values:

```bash
npm run build
node scripts/run-benchmark-pair.mjs \
  --suite benchmarks/lisp-org-v1/suite.json \
  --baseline-profile benchmarks/profiles/filesystem-baseline.example.json \
  --candidate-profile benchmarks/profiles/emacs-operator.example.json \
  --baseline-command-json '["/absolute/path/to/filesystem-agent-wrapper"]' \
  --candidate-command-json '["/absolute/path/to/emacs-operator-agent-wrapper"]' \
  --output-dir artifacts/lisp-org-pair-seed-11 \
  --trials 3 \
  --seed 11 \
  --allow-command-checks
```

Repeat a predeclared set of seeds and alternate execution order to reduce order and warm-cache effects. Do not combine reports with different run seeds as paired samples.

Do not interpret one result as universal evidence. It applies only to the recorded suite revision, provider/model version, prompt policy, tool profile, machine, runtime versions, seed set, and sample size.
