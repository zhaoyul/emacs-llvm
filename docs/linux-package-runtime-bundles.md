# Linux Package Runtime Bundles

Alpha.15 introduces a reproducible, offline-first supply chain for package-specific acceptance.

## Security model

- Every executable bundle has an immutable manifest and per-file SHA-256.
- Archives are extracted into a private staging directory and published atomically.
- Absolute paths, `..`, symlinks, hardlinks, devices, duplicate paths, case collisions and size-limit violations are rejected before publication.
- Runtime supervisors bind loopback only and launch commands from an allowlisted manifest.
- Emacs proves the actual loaded library and command source paths against the prepared bundle.
- A package is never marked `pass` merely because `(featurep ...)` is true.

## Bridge authentication tokens

Launchers generate one 256-bit token per Emacs instance using the operating-system CSPRNG and publish it as an owner-only `0600` file inside a `0700` directory. Emacs validates type, owner, mode, symlink status, format and length before use. Autonomous startup uses `gnutls-random` or a no-shell `head -c 32 /dev/urandom` fallback. It never seeks within `/dev/urandom`.

Detected legacy token functions overridden by the secure provider:

```text
emacs-operator--secure-random-token
```

## Current real-package state

- Paredit pinned source available: `False`.
- CIDER/nREPL requires the complete locked Emacs dependency graph plus a Clojure runtime.
- SLY/Slynk requires pinned SLY sources plus a supported Common Lisp runtime such as SBCL.

Missing dependencies remain `not_run`; fixture runtimes only prove the bundle, supervisor and provenance machinery.
