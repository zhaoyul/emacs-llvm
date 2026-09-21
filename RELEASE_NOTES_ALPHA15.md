# Emacs Operator 0.1.0-alpha.15

## Highlights

- Added reproducible offline package-runtime bundle contracts and provenance checks.
- Added safe archive extraction and atomic preparation.
- Added loopback-only runtime supervision for nREPL and Slynk acceptance.
- Added Emacs package-runtime state and loaded-source identity probes.
- Replaced seek-based `/dev/urandom` token creation with launcher-generated private token files and a secure autonomous fallback.
- Added pinned real Paredit acceptance when the verified source is available.
- Kept missing CIDER/nREPL and SLY/Slynk runtimes as explicit `not_run`.
