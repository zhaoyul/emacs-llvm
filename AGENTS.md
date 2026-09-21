# AGENTS.md

This repository implements the architecture in `docs/EMACS_AGENT_SKILL_DESIGN.md`.

Rules for implementation agents:

1. Preserve the three independent execution channels: semantic, internal_keys, native_keys.
2. Implement semantic and internal_keys before native_keys.
3. Never treat Emacs current buffer as persistent cross-call state. Use stable handles and explicit sessions.
4. Every mutation must support preconditions and audit metadata.
5. Do not hard-code user key bindings. Ask Emacs to resolve keymaps.
6. Do not use screenshots/OCR as a substitute for bridge state.
7. Do not log bridge tokens or unrestricted source text.
8. Do not use fixed sleeps for Emacs/repl synchronization when a state predicate can be observed.
9. Add tests for each public behavior.
10. Update STATUS.md after each phase.
11. Architecture changes require an ADR under docs/adr/.
12. The codebase must remain platform-neutral above `PlatformDriver`.

Current implementation status is recorded in `STATUS.md`.
