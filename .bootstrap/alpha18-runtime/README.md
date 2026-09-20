# Alpha.18 runtime patch capsule

This directory persists the validated Alpha.18 Emacs runtime work while the Alpha.16 full source baseline is being materialized.

## Integrity

- Base source version: `0.1.0-alpha.16`
- Transport: `base64(xz(git patch))`
- Base64 bytes: `22968`
- Base64 SHA-256: `f82c23b4ba9f0f0e72696f1b7688bf7e19d34fe72341df934a17681f5ff544dc`
- XZ bytes: `17224`
- XZ SHA-256: `d1aa97c69c90fe6974d155f53540ea9736be1ac7ff6011c18b557d4e21f7de54`
- Patch bytes: `89928`
- Patch SHA-256: `9e9d704089ecc2cad4ccaf47ed7b646c8fecc0e3c11cb276e09940d5670188ac`

## Reconstruct

```bash
set -euo pipefail
cat .bootstrap/alpha18-runtime/part-*.txt > /tmp/alpha18-runtime.patch.xz.b64
printf '%s  %s\n' \
  f82c23b4ba9f0f0e72696f1b7688bf7e19d34fe72341df934a17681f5ff544dc \
  /tmp/alpha18-runtime.patch.xz.b64 | sha256sum --check --strict
base64 --decode /tmp/alpha18-runtime.patch.xz.b64 > /tmp/alpha18-runtime.patch.xz
printf '%s  %s\n' \
  d1aa97c69c90fe6974d155f53540ea9736be1ac7ff6011c18b557d4e21f7de54 \
  /tmp/alpha18-runtime.patch.xz | sha256sum --check --strict
xz --decompress --stdout /tmp/alpha18-runtime.patch.xz > /tmp/alpha18-runtime.patch
printf '%s  %s\n' \
  9e9d704089ecc2cad4ccaf47ed7b646c8fecc0e3c11cb276e09940d5670188ac \
  /tmp/alpha18-runtime.patch | sha256sum --check --strict
patch --batch --dry-run -p5 < /tmp/alpha18-runtime.patch
patch --batch -p5 < /tmp/alpha18-runtime.patch
```

`capsule-manifest.json` contains the changed-file hashes and validation evidence. The capsule must be applied only to the verified Alpha.16 source baseline.
