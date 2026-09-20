# Emacs Operator 0.1.0-alpha.11

Alpha.11 adds an objective Lisp and Org Agent benchmark harness. It is an evaluation layer, not a new production MCP capability.

## Highlights

- Fresh isolated fixture workspace for every trial.
- SHA-256 suite, task, profile and workspace identities.
- Stable per-task `trial_seed` values shared by controlled baseline/candidate pairs.
- Independent final-state scoring that does not trust the Agent's completion claim.
- Hard failure on unauthorized or protected path changes.
- Bounded, sanitized JSONL traces and redacted command descriptors.
- Opt-in command verifiers executed in disposable workspace copies.
- Paired Agent profiles with same-control/different-tool enforcement and secret-shaped field rejection.
- Exact suite digest and run-seed pairing guard.
- Deterministic bootstrap 95% confidence interval for paired score deltas.
- Eight behavior-oriented Emacs Lisp, Clojure, Common Lisp and Org/Babel tasks.
- Language-aware project Rename semantics for Clojure qualified symbols and Common Lisp external/internal package symbols, with qualification changes rejected before mutation.
- Five portable harness-sensitivity tasks.
- `npm run accept:alpha11` portable release gate.

## Commands

```bash
npm run benchmark:validate
npm run benchmark:sensitivity
npm run accept:alpha11
```

For a real controlled pair, build first and use `scripts/run-benchmark-pair.mjs` with reviewed profiles and protocol-compatible Agent wrappers. See `docs/benchmarking.md`.

## Security and interpretation

The Agent request omits checks, verifier source, expected outputs and protected-path rules. This prevents accidental oracle disclosure through the protocol, but the Agent process is not adversarially sandboxed. Command verifiers run in a disposable workspace copy, but their process can still access networks, absolute paths, other processes and external services unless the operator supplies OS-level isolation.

The deterministic 0/5 naive versus 5/5 semantic sensitivity result validates the harness only. It is not a claim about LLM quality or universal Emacs Operator superiority. Real conclusions must be scoped to the recorded suite revision, model version, prompt policy, tool profile, machine, language runtimes, seeds and sample size.

## Runtime status in the implementation container

- TypeScript tests: 88/88 PASS.
- Refactor-intelligence tests: 29/29 PASS.
- Swift portable tests: 5/5 PASS.
- Deterministic harness sensitivity: expected 0/5 versus 5/5 PASS.
- GNU Emacs ERT and real language benchmark tasks: NOT RUN because the required runtimes are unavailable.
- macOS native acceptance: NOT RUN in Linux.
