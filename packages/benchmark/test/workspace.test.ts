import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { copyFixtureTree, diffWorkspace, protectedPathViolations, snapshotWorkspace, unauthorizedPathViolations } from "../src/workspace.js";
import { temporaryDirectory } from "./helpers.js";

test("workspace snapshots ignore private trace data and summarize file changes", () => {
  const root = temporaryDirectory();
  try {
    const fixture = path.join(root, "fixture");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, "a.txt"), "a\n");
    fs.writeFileSync(path.join(fixture, "protected.txt"), "p\n");
    copyFixtureTree(fixture, workspace, 1024);
    const before = snapshotWorkspace(workspace, 1024);
    fs.mkdirSync(path.join(workspace, ".emacs-operator-benchmark"));
    fs.writeFileSync(path.join(workspace, ".emacs-operator-benchmark", "trace.jsonl"), "large trace ignored\n");
    fs.writeFileSync(path.join(workspace, "a.txt"), "b\n");
    fs.writeFileSync(path.join(workspace, "extra.txt"), "x\n");
    const after = snapshotWorkspace(workspace, 1024);
    const diff = diffWorkspace(before, after);
    assert.deepEqual(diff.modified, ["a.txt"]);
    assert.deepEqual(diff.added, ["extra.txt"]);
    assert.deepEqual(protectedPathViolations(diff, ["a.txt"]), ["a.txt"]);
    assert.deepEqual(unauthorizedPathViolations(diff, ["a.txt"]), ["extra.txt"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("fixture copying rejects symlinks", { skip: process.platform === "win32" }, () => {
  const root = temporaryDirectory();
  try {
    const fixture = path.join(root, "fixture");
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(root, "real.txt"), "x");
    fs.symlinkSync(path.join(root, "real.txt"), path.join(fixture, "link.txt"));
    assert.throws(() => copyFixtureTree(fixture, path.join(root, "workspace"), 1024), /symbolic link/iu);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("allowed path globs distinguish authorized source edits from collateral files", async () => {
  const { pathMatchesPattern } = await import("../src/pathSafety.js");
  assert.equal(pathMatchesPattern("src/bench/math.clj", "src/**/*.clj"), true);
  assert.equal(pathMatchesPattern("src/math.clj", "src/**/*.clj"), true);
  assert.equal(pathMatchesPattern("src/bench/math.edn", "src/**/*.clj"), false);
  assert.equal(pathMatchesPattern("README.md", "src/**/*.clj"), false);
});
