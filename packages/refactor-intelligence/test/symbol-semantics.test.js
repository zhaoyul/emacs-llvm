import test from "node:test";
import assert from "node:assert/strict";
import { describeLispSymbol, prepareSymbolRename } from "../src/index.js";

test("describes Clojure qualified symbols without conflating keywords", () => {
  const symbol = describeLispSymbol("app.calc/sum", "clojure");
  assert.equal(symbol.kind, "qualified_symbol");
  assert.equal(symbol.qualifier, "app.calc");
  assert.equal(symbol.name, "sum");
  assert.equal(symbol.renameable, true);
  const keyword = describeLispSymbol(":app.calc/sum", "clojure");
  assert.equal(keyword.kind, "qualified_keyword");
  assert.equal(keyword.renameable, false);
});

test("leaf-only Clojure rename preserves the namespace", () => {
  const result = prepareSymbolRename({
    oldSymbol: "app.calc/sum",
    newSymbol: "add",
    language: "clojure",
    qualificationPolicy: "leaf_only"
  });
  assert.equal(result.effective_new_symbol, "app.calc/add");
  assert.equal(result.new.qualifier, "app.calc");
});

test("Clojure qualification changes are rejected by default", () => {
  assert.throws(
    () => prepareSymbolRename({ oldSymbol: "app.calc/sum", newSymbol: "other/add", language: "clojure" }),
    (error) => error?.code === "E_SYMBOL_QUALIFICATION_CHANGE"
  );
});

test("Common Lisp preserves external versus internal package semantics", () => {
  const external = describeLispSymbol("math:sum", "common_lisp");
  const internal = describeLispSymbol("math::sum", "common_lisp");
  assert.equal(external.kind, "package_external_symbol");
  assert.equal(internal.kind, "package_internal_symbol");
  assert.throws(
    () => prepareSymbolRename({ oldSymbol: "math:sum", newSymbol: "math::add", language: "common_lisp" }),
    (error) => error?.code === "E_SYMBOL_QUALIFICATION_CHANGE"
  );
});

test("Common Lisp identity comparison is case-insensitive", () => {
  assert.throws(
    () => prepareSymbolRename({ oldSymbol: "math:sum", newSymbol: "MATH:SUM", language: "common_lisp" }),
    (error) => error?.code === "E_SYMBOL_IDENTITY_UNCHANGED"
  );
});

test("keywords and reader-sensitive symbols require an explicit data migration", () => {
  assert.throws(
    () => prepareSymbolRename({ oldSymbol: ":status", newSymbol: ":state", language: "clojure" }),
    (error) => error?.code === "E_SYMBOL_NOT_RENAMEABLE"
  );
  assert.equal(describeLispSymbol("#:temporary", "common_lisp").renameable, false);
});
