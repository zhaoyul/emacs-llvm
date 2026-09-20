# Linux private GNU Emacs runtime

Alpha.16 removes the assumption that the acceptance machine already has GNU Emacs on `PATH`.

The resolver checks, in order:

1. `EMACS_OPERATOR_EMACS_BIN`;
2. `EMACS_OPERATOR_EMACS_RUNTIME_ROOT`;
3. `.runtime/emacs/current/bin/emacs` and private-runtime fallbacks;
4. `emacs`, `emacs-gtk`, or `emacs-nox` on `PATH`.

Every candidate is executed in batch mode and must report GNU Emacs major version 29 or newer.

## Provision from local Debian packages

Keep downloaded `.deb` files outside the source tree. Include the Emacs package and every shared-library/runtime dependency required by that package.

```bash
mkdir -p /secure/cache/emacs-debs

node scripts/runtime/provision-emacs-runtime.mjs lock \
  --source-dir /secure/cache/emacs-debs \
  --out /secure/cache/emacs-runtime.lock.json \
  --id debian-trixie-emacs-30

node scripts/runtime/provision-emacs-runtime.mjs provision \
  --lock /secure/cache/emacs-runtime.lock.json \
  --source-dir /secure/cache/emacs-debs \
  --dest .runtime/emacs \
  --activate
```

The lock records Debian package metadata plus SHA-256 for every `.deb`. Provisioning rechecks both before extraction, writes into a private staging directory, probes the resulting Emacs, and only then atomically publishes the runtime.

After activation:

```bash
npm run test:elisp
EMACS_OPERATOR_LINUX_REQUIRE_EMACS=1 \
EMACS_OPERATOR_LINUX_REQUIRE_GUI_EMACS=1 \
npm run accept:linux
```

## Locked package sources

Paredit, CIDER, and SLY source provenance is recorded in:

```text
scripts/package-runtime/sources.lock.json
```

Acquire a source only at its full commit SHA:

```bash
node scripts/package-runtime/acquire-git-source.mjs acquire \
  --lock scripts/package-runtime/sources.lock.json \
  --name paredit \
  --dest .runtime/sources
```

The acquisition tool checks the exact commit, rejects unapproved network repository shapes, rejects symlinks/special files in the exported tree, and emits a per-file SHA-256 manifest.

Package source availability is not package runtime acceptance. CIDER still requires a real Clojure+nREPL connection and SLY still requires a real Common Lisp+Slynk connection.

## CI segmentation

The complete Linux gate may be run separately from the portable alpha.16 gate. After `accept:linux` produces a passing `summary.json`, pass its directory back to the release gate:

```bash
EMACS_OPERATOR_ALPHA16_REUSE_LINUX_REPORT_DIR=/path/to/linux-report \
npm run accept:alpha16
```

The reused report is accepted only when its schema, platform, exit code, overall result, X11/XTEST coverage, reliability coverage, and installed-host coverage are passing. This avoids treating an orchestration wall-clock limit as a product failure while preserving machine-verifiable evidence.
