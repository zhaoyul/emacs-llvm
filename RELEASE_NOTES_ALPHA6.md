# Emacs Operator 0.1.0-alpha.6

Alpha.6 turns structural correctness and repair into first-class agent concepts.

## Highlights

- New read-only MCP `emacs_validate` tool and Bridge `adapter.validate` method.
- Lisp delimiter and Emacs Lisp reader diagnostics with bounded source context.
- Emacs Lisp language-level failures normalized to `completed=false` results with condition, stderr, source bounds/hash and bounded backtrace metadata.
- JSON-friendly return values from allowlisted safe noninteractive semantic commands.
- Structured Org constructors for headings, tables and Babel source blocks.
- Whole-document Org summaries for headings, tables and source blocks without returning source bodies.
- New live `accept:workflows` suite for complete Lisp repair and Org authoring loops.
- `accept:macos` now runs workflow acceptance before native CGEvent/capture acceptance.
- Agent Skill now requires structural validation before Lisp/Org checkpoint commit.

## Portable verification

- Version metadata: synchronized at `0.1.0-alpha.6`.
- TypeScript: 33/33 tests pass.
- Swift portable host tests: 5/5 pass on Linux.
- Elisp lexical delimiter sanity: 14 files pass.
- MCPB: manifest/server version consistency and packaged-server initialize/health smoke pass.
- Workflow failure reporting: no-Bridge path exits nonzero and writes `summary.ok=false`.

GNU Emacs ERT and real macOS native acceptance are not claimed in the Linux build environment. Run `npm run accept:macos` on the target Mac before promoting beyond alpha.
