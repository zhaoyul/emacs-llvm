# Architecture

See `EMACS_AGENT_SKILL_DESIGN.md` for the normative architecture.

The current implementation layers are:

1. MCP stdio facade with structured tool envelopes and image content for captures.
2. Alpha.7 semantic transaction coordinator (`emacs_workflow`) that composes allowlisted primitives and owns checkpoint/validate/verify/commit-or-rollback for bounded Lisp/Org tasks.
3. Explicit session, policy, audit, idempotency and per-instance mutation lease.
4. Platform-neutral bridge client and protocol package.
5. Emacs Lisp bridge with semantic operations, internal key replay and mode adapters.
6. Lisp, Org, SLY and CIDER adapter registry.
7. macOS Host local RPC with runtime discovery and token authentication.
8. macOS Accessibility focus management and CGEvent native keyboard injection.
9. ScreenCaptureKit single-window capture with transient private PNG storage.

The OS boundary stays behind `PlatformDriver`. Future Windows and Linux implementations replace that driver while preserving MCP, session and Emacs bridge contracts.


The semantic transaction coordinator is deliberately outside Emacs. It never evaluates orchestration source. It invokes the same MCP tool router paths used by explicit agent calls, so nested policy, workspace, stale-state and audit checks remain authoritative. Proposal failures roll back to the coordinator-owned checkpoint; infrastructure or rollback failures remain errors.
