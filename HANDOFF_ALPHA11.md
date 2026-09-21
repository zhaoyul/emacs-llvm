# Alpha.11 handoff

## Portable gate

```bash
npm run accept:alpha11
```

Do not convert a missing GNU Emacs/runtime status into a pass. The portable gate validates the harness and packaging, not real Agent advantage.

## Real macOS runtime gate

On macOS with GNU Emacs 29+, the Host app, permissions, and required Lisp runtimes:

```bash
npm run accept:macos
```

This now includes benchmark corpus validation and the deterministic sensitivity probe before ERT and real Emacs/native acceptance. It deliberately does not launch paid or networked LLM experiments.

## Controlled benchmark preparation

1. Review `docs/benchmarking.md` and every runtime verifier.
2. Install GNU Emacs 29+, Clojure CLI or the selected Clojure runtime, SBCL, paredit, CIDER and SLY as required by the tasks.
3. Run experiments in a container, VM, or dedicated low-privilege account. The harness is not an OS sandbox.
4. Implement two protocol wrappers: a filesystem/shell baseline and an Emacs Operator candidate. The example wrapper intentionally refuses work and is only a protocol template.
5. Copy and complete the example profiles. Keep provider, exact model version, prompt policy, sampling controls, context budget, cross-trial memory and network policy identical. Only `tool_profile` should differ.
6. Predeclare suite revision, trial count, seeds, timeout, command-check policy and exclusion criteria.
7. Use `scripts/run-benchmark-pair.mjs` for each seed and alternate execution order across seeds.
8. Preserve `baseline.json`, `candidate.json`, `comparison.json`, `experiment.json`, stderr logs, runtime versions and machine metadata.

## Important review targets

- Confirm Agent requests contain no `checks`, verifier paths/source, protected-path rules or expected outputs.
- Confirm reports from different run seeds are rejected as a pair.
- Confirm baseline/candidate receive identical derived `trial_seed` values for matching task/trial pairs.
- Confirm verifier writes do not alter the scored final workspace.
- Confirm unauthorized/protected path changes are hard failures.
- Confirm missing runtimes produce unavailable/skipped results, never passes.
- Exercise real xref project Rename for Clojure `ns/name` and Common Lisp `pkg:name`/`pkg::name`, and confirm qualification drift is rejected before mutation.
- Confirm the production MCPB does not contain `packages/benchmark`, `benchmarks`, experimental profiles or wrappers.

## Recommended first experiment

Start with one or two predeclared seeds and one trial per task as a dry run. Inspect every failure manually. Only after protocol, isolation, trace and runtime behavior are trusted should the trial count be increased for comparative evidence.
