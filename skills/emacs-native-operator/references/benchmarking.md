# Benchmarking reference

The benchmark harness is evaluation infrastructure, not an MCP tool and not part of the runtime MCPB.

Use it only when measuring Agent behavior. Do not expose suite checks, expected files, verifier source, allowed paths, or protected-path declarations to the Agent under test. The Agent receives the task prompt, fresh workspace, fingerprints, trial number, and stable `trial_seed`.

For a controlled comparison, use `scripts/run-benchmark-pair.mjs` with two validated profiles. The profiles must hold model, snapshot, prompt policy, sampling, context budget, memory, and network controls constant; only the declared tool profile should differ.

Do not claim universal superiority from one result. Report the exact suite revision/digest, profiles, run seed, trials, unavailable tasks, command-check policy, pass rates, paired outcomes, and confidence interval.

Command checks execute code and require explicit `--allow-command-checks`. They run against disposable workspace copies, but neither Agent nor verifier processes are operating-system sandboxes. Use a container, VM, or restricted account for hostile or publishable experiments.

Primary commands:

```bash
npm run benchmark:validate
npm run benchmark:preflight
npm run benchmark:sensitivity
npm run benchmark -- profile-validate --profile FILE
npm run build
node scripts/run-benchmark-pair.mjs ...
```

See `docs/benchmarking.md` for the full protocol.
