# Emacs Operator 0.1.0-alpha.12

Alpha.12 adds real-agent experiment integration without adding vendor-specific production MCP surface.

## Added

- Provider-neutral JSONL Agent Driver Protocol v1.
- Filesystem baseline and Emacs Operator candidate wrappers over the same executable.
- Ephemeral mode-0600 MCP configuration outside task workspaces.
- Baseline stripping of MCP and Emacs Operator environment variables.
- Explicit credential environment-name allowlists with report redaction.
- Timeout, output, event, artifact-path, request-id and single-result enforcement.
- POSIX process-group termination and Windows fallback.
- Deterministic paired order and identical per-task trial seeds.
- Pair-profile invariants that keep model and sampling configuration equal.
- Redacted JSONL traces and auditable experiment manifest.
- Mock protocol driver and portable end-to-end tests.

## Boundaries

No paid or networked LLM experiment was run in the build container. Wrapper tests demonstrate protocol and isolation behavior, not that Emacs Operator wins the benchmark. Real experiments still require the Alpha.11 independent scorer and OS-level isolation.
