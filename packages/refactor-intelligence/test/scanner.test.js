import test from "node:test"; import assert from "node:assert/strict";
import {scanLisp,symbolOccurrences,validateLispSymbol} from "../src/index.js";
test("scanner excludes comments and strings",()=>{const s='(foo "foo") ; foo\n(foo/bar foo)';const o=symbolOccurrences(s,"foo").occurrences;assert.equal(o.length,2);assert.equal(o[0].start,1);});
test("scanner handles nested block comments",()=>{const s='#| foo #| foo |# |# (foo)';assert.equal(symbolOccurrences(s,"foo").occurrences.length,1);});
test("symbol validation rejects reader-shaped input",()=>{assert.throws(()=>validateLispSymbol("foo bar"));assert.throws(()=>validateLispSymbol("(foo)"));});

test("balance checker reports unmatched and mismatched delimiters", async () => {
  const { checkLispBalance } = await import("../src/index.js");
  assert.equal(checkLispBalance('(foo [1 2])').balanced, true);
  const unclosed = checkLispBalance('(foo [1 2]');
  assert.equal(unclosed.balanced, false);
  assert.ok(unclosed.diagnostics.some((item) => item.code === "unclosed_opening_delimiter"));
  const mismatched = checkLispBalance('(foo]');
  assert.ok(mismatched.diagnostics.some((item) => item.code === "mismatched_closing_delimiter"));
});
