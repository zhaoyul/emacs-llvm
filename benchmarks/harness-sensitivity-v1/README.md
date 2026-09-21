# Benchmark harness sensitivity suite v1

This portable suite verifies the benchmark harness itself. It compares a deterministic semantic reference implementation with an intentionally naive text implementation. A 5/5 versus 0/5 split demonstrates that the encoded checks detect these known failure modes. It does not demonstrate that one LLM, editor, or product is generally better than another.

Run it with:

```bash
npm run benchmark:sensitivity
```

The Agent receives the prompt, a stable per-trial seed, and an isolated workspace. It does not receive suite checks, expected files, protected-path rules, or verifier source through the request protocol. The command process and verifier process are not operating-system sandboxes, so this is a cooperative harness probe rather than an adversarial secrecy or containment boundary.
