# Safety

`workspace_edit` is a cooperative application policy, not an operating-system sandbox. The bridge blocks common arbitrary evaluation, shell and out-of-workspace save paths, while the MCP layer validates target file paths and mutation leases.

For stronger isolation, run Emacs Operator inside an OS/container sandbox whose filesystem and process permissions already match the intended workspace.

Tokens, unrestricted source text and screenshots are not written to the audit log.
