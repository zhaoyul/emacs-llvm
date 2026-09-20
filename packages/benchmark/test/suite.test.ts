import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadBenchmarkSuite, suiteUsesCommandChecks } from "../src/suite.js";
import { temporaryDirectory, writeSuite } from "./helpers.js";

test("suite loader validates and fingerprints prompts and fixtures", () => {
  const root = temporaryDirectory();
  try {
    const file = writeSuite(root);
    const first = loadBenchmarkSuite(file);
    assert.equal(first.suite.id, "synthetic-answer");
    assert.equal(first.tasks.length, 1);
    assert.equal(first.tasks[0]!.prompt.includes("42"), true);
    const digest = first.digest;
    fs.writeFileSync(path.join(root, "fixtures", "answer", "answer.txt"), "41\n");
    const second = loadBenchmarkSuite(file);
    assert.notEqual(second.digest, digest);
    assert.notEqual(second.tasks[0]!.digest, first.tasks[0]!.digest);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("suite loader rejects traversal and duplicate check ids", () => {
  const root = temporaryDirectory();
  try {
    const file = writeSuite(root);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.tasks[0].prompt_file = "../prompt.md";
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadBenchmarkSuite(file), /escapes its root/u);
    value.tasks[0].prompt_file = "prompts/answer.md";
    value.tasks[0].checks.push({ ...value.tasks[0].checks[0] });
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadBenchmarkSuite(file), /duplicate check id/iu);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("suite loader detects command checks", () => {
  const root = temporaryDirectory();
  try { assert.equal(suiteUsesCommandChecks(loadBenchmarkSuite(writeSuite(root, { commandCheck: true }))), true); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("suite loader rejects symlinks in fixtures", { skip: process.platform === "win32" }, () => {
  const root = temporaryDirectory();
  try {
    const file = writeSuite(root);
    fs.symlinkSync(path.join(root, "prompts", "answer.md"), path.join(root, "fixtures", "answer", "link.md"));
    assert.throws(() => loadBenchmarkSuite(file), /symbolic link/iu);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
