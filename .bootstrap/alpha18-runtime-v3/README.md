# Alpha.18 locked package runtime capsule v3

Replayable patch against verified `0.1.0-alpha.16` clean source baseline.

V3 adds locked package load-path precedence, TypeScript 5.8.3 + npm lockfile, direct CIDER Maven artifact sealing, and runtime-common determinism/security gates.

```bash
cat part-*.txt | base64 --decode > alpha18-runtime-v3.patch.xz
echo "db608ccad7127ce7a20e2acece5a62a3fd8afcb8c84d987dc202b84a0aeba4cf  alpha18-runtime-v3.patch.xz" | sha256sum -c -
xz -dc alpha18-runtime-v3.patch.xz > alpha18-runtime-v3.patch
echo "7b96d5cf9ca4ad2703573318f1c0690aac21401f226381ed7876bf963af8377a  alpha18-runtime-v3.patch" | sha256sum -c -
patch -p1 --batch < alpha18-runtime-v3.patch
```

Local validation: 34/34 package-runtime, 93/93 TypeScript, typecheck/version/Elisp/YAML/Bash PASS. Real GNU Emacs GUI + CIDER/SLY runtime remains the GitHub Actions authority.
