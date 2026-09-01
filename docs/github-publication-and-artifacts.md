# GitHub publication and release artifacts

The canonical repository stores the Emacs Operator source tree directly at the repository root. A nested `emacs-operator/` directory, `.bootstrap` transport fragments, or tracked build/runtime state are publication failures.

## Portable repository gate

```bash
npm ci
npm run check:repository-import
npm run check:version
npm run typecheck
npm run check:elisp-structure
npm run test:ts
npm run test:alpha10-intelligence
npm run test:agent-experiment
npm run linux-host:test
```

`.github/workflows/remote-publication-verification.yml` executes the same contract against the public `main` branch. It additionally requires version `0.1.0-alpha.16`, at least 300 tracked source files, required Linux/macOS/Emacs runtime paths, and no `.bootstrap` directory.

## Release artifact workflow

`.github/workflows/build-release-artifacts.yml` can be started manually or by pushing a `v*` tag. It builds:

- a source ZIP from the exact Git commit;
- the MCPB package;
- the Linux x86_64 Host bundle;
- `SHA256SUMS.txt`;
- `BUILD_INFO.json` containing the version, commit, and workflow run identity.

The workflow validates every archive and checksum before uploading one GitHub Actions artifact. It does not automatically create a public GitHub Release or claim package-specific CIDER/SLY acceptance.

## Platform acceptance boundary

Portable CI does not replace:

- real GNU Emacs ERT and Bridge acceptance;
- paredit internal-key acceptance;
- CIDER with a real nREPL runtime;
- SLY with a real Slynk runtime;
- Linux X11/XTEST or Wayland native acceptance;
- macOS Accessibility, CGEvent, and ScreenCaptureKit acceptance.

Those gates remain explicit platform/runtime jobs and must report unavailable dependencies as `not_run` or a required failure, never as a pass.
