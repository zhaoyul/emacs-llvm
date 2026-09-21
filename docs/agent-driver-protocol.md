# External Agent Driver Protocol v1

Alpha.12 adds a provider-neutral process boundary between the benchmark harness and a real coding agent. The same executable and model configuration should be used for both sides. Only the tool grant differs.

## Transport

The harness starts the configured executable without a shell, sets the trial workspace as `cwd`, and sends exactly one JSON request followed by a newline on stdin. The driver emits JSON Lines on stdout. Zero or more `event` envelopes may precede exactly one `result` envelope.

```json
{"protocol_version":"emacs-operator.agent-driver/1","request_id":"req_...","kind":"event","event":{"type":"tool.call"}}
{"protocol_version":"emacs-operator.agent-driver/1","request_id":"req_...","kind":"result","result":{"status":"completed","summary":"done"}}
```

Human diagnostics belong on stderr. Stdout must contain protocol JSON only.

## Baseline isolation

The filesystem baseline receives no MCP config, no Emacs Operator tool names, and no inherited `EMACS_OPERATOR_*` or `MCP_*` variables. The candidate receives an ephemeral mode-0600 MCP config outside the task workspace. The config is deleted after the invocation.

## Secrets

Profiles contain only environment variable names, never credential values. Credential values may be inherited only when explicitly listed in `secret_env_names`. Traces record names and sensitivity flags, not values. Driver output containing secret-shaped object keys is rejected.

## Limits

The wrapper enforces a bounded timeout, bounded stdout/stderr, one result envelope, event count limits, workspace-relative artifact paths, and process-group termination. These controls are not an OS sandbox. Formal experiments still require a disposable container, VM, or dedicated low-privilege account.
