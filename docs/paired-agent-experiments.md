# Paired Real-Agent Experiments

Alpha.12 supplies two wrappers over the same external agent driver:

- `createFilesystemBaselineAgent(profile)`.
- `createEmacsOperatorCandidateAgent(profile)`.

Profiles must match on provider, model snapshot, prompt policy, sampling settings, context budget, memory policy, network policy, and pairing key. The only intended experimental difference is `tool_profile`.

Every task/trial gets one deterministic `trial_seed`. Baseline and candidate use separate fresh workspaces and receive the same prompt and seed. Invocation order is derived deterministically from suite digest, task, trial, and run seed, reducing a fixed first-run bias.

The wrapper report is execution evidence, not the benchmark score. Alpha.11's independent scorer remains authoritative and must evaluate final files and runtime verifiers without trusting the agent summary.

## Commands

```bash
npm run benchmark:agent:preflight -- --config /path/to/experiment.json --output /tmp/preflight.json
npm run benchmark:agent:pair -- --config /path/to/experiment.json
```

A real provider adapter only needs to implement the JSONL driver protocol. Vendor credentials remain outside the profile and outside report artifacts.
