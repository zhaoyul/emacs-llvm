# Emacs Operator 0.1.0-alpha.10

Alpha.10 turns the alpha.9 analysis-first design into an end-to-end MCP capability and adds guarded lifecycle state for project-wide rename and runtime verification.

## Highlights

- `emacs_analyze` is now a real MCP -> Bridge -> adapter path, not only a design/helper layer.
- The generic adapter registry has an explicit read-only analyzer slot and rejects analyzer-induced buffer mutations.
- `extract_function` automatically infers parameters when the caller omits `parameters`.
- Extraction refuses unresolved free-variable analysis with stable `E_ANALYSIS_UNRESOLVED` before checkpoint or mutation.
- Enclosing `let`/`let*`-style lexical bindings are included conservatively in extraction analysis.
- `emacs_project_rename` now exposes `plan -> preview -> apply -> status -> rollback/commit`.
- Project rename preview is bounded and read-only. Apply never saves files.
- Apply produces a TTL-bound rollback journal. `status` exposes only hashes/metadata, never the retained source snapshots.
- Rollback preflights every applied buffer and refuses to overwrite subsequent buffer or on-disk changes.
- `emacs_verification` adds session-bound verification tickets for structured Elisp/CIDER/SLY evaluation.
- Verification reruns require both a stable structured-evaluation target locator and a changed buffer-derived source fingerprint. Moving point/region to a different target stops with `source_target_changed`; high/unknown side-effect risk still requires explicit authorization.
- Elisp/CIDER/SLY structured evaluation metadata now includes `source_start`, `source_bounds`, `source_sha256`, and source byte size where applicable.
- Bridge capability reporting advertises adapter analysis, rename journals, and verification tickets.
- `accept:alpha10` creates a machine-readable portable release report and smoke-tests the extracted MCPB server.

## Transaction boundaries

Project rename journals are buffer transactions. They do not save files and do not roll back runtime, database, network, process, or filesystem side effects. The journal retains bounded in-memory source snapshots only for conflict-checked buffer rollback and expires automatically.

Verification tickets are rerun guards, not runtime transactions. They reduce accidental repeated side effects by requiring source change and explicit risk authorization where needed.

## Validation in the implementation container

- TypeScript main tests: 52/52 pass.
- Refactor-intelligence tests: 20/20 pass.
- Swift portable tests: 5/5 pass.
- Elisp lexical delimiter check: pass for 16 files.
- MCPB packaging and extracted-server initialize/health smoke: pass.
- GNU Emacs ERT: not run because GNU Emacs 29+ is unavailable in this Linux container.
- Real macOS CGEvent/Accessibility/ScreenCaptureKit acceptance: not run in this Linux container.

For a real Mac, `npm run accept:macos` remains the authoritative full-stack gate.
