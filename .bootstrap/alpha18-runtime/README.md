# Alpha.18 locked Emacs runtime patch capsule

This capsule is a replayable patch against the verified `0.1.0-alpha.16` source baseline.

Reconstruct and apply from this directory:

```bash
cat part-*.txt | base64 --decode > alpha18-runtime-final.patch.xz
echo "203f42bb24cd77527a38cdf2c411e98e14dcd77c813eb2bf521aa8899ca4fd7d  alpha18-runtime-final.patch.xz" | sha256sum -c -
xz -dc alpha18-runtime-final.patch.xz > alpha18-runtime-final.patch
echo "2a90c5b5d2833c47b2fff0b0ecb41245bff8f0b073e433e5fdb9816e62569619  alpha18-runtime-final.patch" | sha256sum -c -
patch -p1 --batch < alpha18-runtime-final.patch
```

The patch was replay-tested on a fresh Alpha.16 source extraction before publication.
