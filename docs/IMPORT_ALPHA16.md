# Alpha.16 baseline import

This repository is the canonical source of truth for Emacs Operator from the alpha.16 migration onward.

## Source baseline

- Version: `0.1.0-alpha.16`
- Recovered archive: `emacs-operator-alpha16.zip`
- Recovered archive contents: 368 files
- Clean import set: 364 source files after excluding generated Linux host binaries
- Clean source size: approximately 1.65 MiB

## Validation performed before import

```text
npm run check:version          PASS
npm run check:elisp-structure PASS (18 Elisp files)
npm run typecheck             PASS
npm run test:ts               PASS (93/93)
```

## Exclusions

Generated or transient content must not be committed:

- `node_modules/`
- `dist/`
- `artifacts/`
- `runtime/`
- `.runtime/`
- `apps/linux-host/build/`
- `apps/macos-host/.build/`

## Import workflow

1. Restore the clean alpha.16 source tree on `codex/import-alpha16-baseline`.
2. Preserve executable bits on shell, Python and Node entry-point scripts.
3. Run portable validation in GitHub Actions.
4. Run ERT using GNU Emacs.
5. Run Linux X11 and real-Emacs acceptance jobs.
6. Run the macOS Swift host test job.
7. Review and merge the migration PR.

## Continuing development

After the baseline is merged:

- create one `codex/<topic>` branch per coherent change;
- use pull requests for all changes to `main`;
- include exact validation status in each PR;
- distinguish `PASS`, `FAIL`, and `NOT_RUN` explicitly;
- do not report package capability discovery as package runtime acceptance;
- keep Linux as the authoritative development platform until the macOS local acceptance gate is complete.

Tracking issue: `#1`.
