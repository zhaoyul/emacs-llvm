import test from "node:test";
import assert from "node:assert/strict";
import { checkLispBalance, parseOrgStructure } from "../src/structure.js";

test("Lisp balance ignores strings, line comments, block comments, and character literals", () => {
  const source = `(defun sample (x)\n  ;; ) ignored\n  #| ( #| nested ) |# ) |#\n  (list "(" ?\\) #\\( \\( x))\n`;
  const result = checkLispBalance(source);
  assert.equal(result.balanced, true, JSON.stringify(result.diagnostics));
});

test("Lisp balance reports delimiter and unterminated string errors with locations", () => {
  const result = checkLispBalance("(defun broken ()\n  \"abc\n)");
  assert.equal(result.balanced, false);
  assert.equal(result.diagnostics.some((item) => item.code === "unterminated_string"), true);
  assert.equal(result.diagnostics.every((item) => item.line >= 1 && item.column >= 0), true);
});

test("Org parser reports headings, tags, properties, tables and source blocks", () => {
  const org = `* TODO Project :alpha:agent:\n:PROPERTIES:\n:OWNER: Kevin\n:END:\n\n| A | B |\n| 1 | 2 |\n\n#+begin_src emacs-lisp\n(+ 40 2)\n#+end_src\n`;
  const parsed = parseOrgStructure(org);
  assert.deepEqual(parsed.headings[0], { level: 1, title: "Project", todo: "TODO", tags: ["alpha", "agent"] });
  assert.equal(parsed.tables, 1);
  assert.equal(parsed.src_blocks, 1);
  assert.deepEqual(parsed.source_languages, ["emacs-lisp"]);
  assert.deepEqual(parsed.properties.OWNER, ["Kevin"]);
  assert.deepEqual(parsed.diagnostics, []);
});

test("Org parser detects unterminated source blocks", () => {
  const parsed = parseOrgStructure("#+begin_src emacs-lisp\n(+ 1 2)\n");
  assert.equal(parsed.diagnostics[0]?.code, "unterminated_src_block");
});
