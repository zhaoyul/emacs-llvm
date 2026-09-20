import test from "node:test";
import assert from "node:assert/strict";
import { applyUnifiedDiff, OperatorError } from "../src/index.js";

test("applyUnifiedDiff applies ordered hunks without fuzzy matching", () => {
  const original = "one\ntwo\nthree\nfour\n";
  const diff = [
    "--- a/demo.txt",
    "+++ b/demo.txt",
    "@@ -1,4 +1,5 @@",
    " one",
    "-two",
    "+TWO",
    "+two-and-a-half",
    " three",
    " four",
    ""
  ].join("\n");
  assert.equal(applyUnifiedDiff(original, diff), "one\nTWO\ntwo-and-a-half\nthree\nfour\n");
});

test("applyUnifiedDiff rejects stale context", () => {
  const diff = "@@ -1,1 +1,1 @@\n-old\n+new\n";
  assert.throws(() => applyUnifiedDiff("different\n", diff), (error: unknown) => error instanceof OperatorError && error.code === "E_STATE_CONFLICT");
});
