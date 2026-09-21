# Alpha.12 Implementation Report

The implementation introduces a process-isolated adapter boundary for real coding agents. Both experimental sides use the same driver protocol and executable. The wrapper changes only the tool grant and candidate MCP configuration.

The candidate MCP config is created in a private temporary directory with mode 0600, contains an ephemeral experiment token, and is deleted in a `finally` block. The baseline request and environment contain no MCP config or Emacs Operator tool list.

The driver is spawned without a shell and inside the trial workspace. Output is JSONL with bounded streams, bounded event count, exact request correlation, one final result, relative artifact validation, secret-key rejection, timeout handling and process-group termination.

The paired orchestrator creates separate workspaces from the same fixture, derives the same task-level seed for both sides, deterministically alternates invocation order, and produces a manifest with trace hashes. Agent outcomes are not treated as benchmark scores.
