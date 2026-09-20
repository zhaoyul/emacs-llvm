# Alpha.18 locked package runtime capsule v2

This is a replayable patch against the verified `0.1.0-alpha.16` clean source baseline.

Reconstruct and apply:

```bash
cat part-*.txt | base64 --decode > alpha18-locked-package-runtime.patch.xz
echo "9d1b6dc55e004d15bf93deedd60281546955e9a1ccd68d6a7ca97881cff057ce  alpha18-locked-package-runtime.patch.xz" | sha256sum -c -
xz -dc alpha18-locked-package-runtime.patch.xz > alpha18-locked-package-runtime.patch
echo "1b42eb34821ebc2f71b5c8fb29c9a5d145a1249c1f8ad8cd65c6a12cde97329f  alpha18-locked-package-runtime.patch" | sha256sum -c -
git apply --check alpha18-locked-package-runtime.patch
git apply alpha18-locked-package-runtime.patch
```

This v2 adds the complete MCP `symbol_source` parameter path (catalog -> router -> bridge) on top of the locked package/JVM/SBCL runtime work.
