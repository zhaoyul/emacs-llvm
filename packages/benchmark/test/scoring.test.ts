import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadBenchmarkSuite } from "../src/suite.js";
import { evaluateBenchmarkCheck, scoreTask } from "../src/scoring.js";
import { snapshotWorkspace } from "../src/workspace.js";
import { temporaryDirectory, writeSuite } from "./helpers.js";

test("scoring uses independent checks rather than the agent summary", () => {
  const root = temporaryDirectory();
  try {
    const suite = loadBenchmarkSuite(writeSuite(root));
    const loadedTask = suite.tasks[0]!;
    const workspace = path.join(root, "workspace");
    fs.cpSync(loadedTask.fixture_path, workspace, { recursive: true });
    const before = snapshotWorkspace(workspace, 1024 * 1024);
    fs.writeFileSync(path.join(workspace, "answer.txt"), "42\n");
    const after = snapshotWorkspace(workspace, 1024 * 1024);
    const result = scoreTask(loadedTask, {
      workspace,
      suite_dir: suite.suite_dir,
      before,
      after,
      protected_path_violations: [],
      unauthorized_path_violations: [],
      agent_result: { protocol_version: "1.0", status: "completed", summary: "Trust me." },
      allow_command_checks: false
    }, 1);
    assert.equal(result.passed, true);
    fs.writeFileSync(path.join(workspace, "answer.txt"), "99\n");
    const wrong = scoreTask(loadedTask, {
      workspace,
      suite_dir: suite.suite_dir,
      before,
      after: snapshotWorkspace(workspace, 1024 * 1024),
      protected_path_violations: [],
      unauthorized_path_violations: [],
      agent_result: { protocol_version: "1.0", status: "completed", summary: "Definitely 42." },
      allow_command_checks: false
    }, 1);
    assert.equal(wrong.passed, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("command checks are skipped unless explicitly enabled", () => {
  const root = temporaryDirectory();
  try {
    const suite = loadBenchmarkSuite(writeSuite(root, { commandCheck: true }));
    const loadedTask = suite.tasks[0]!;
    const workspace = path.join(root, "workspace");
    fs.cpSync(loadedTask.fixture_path, workspace, { recursive: true });
    const snapshot = snapshotWorkspace(workspace, 1024 * 1024);
    const command = loadedTask.task.checks.find((check) => check.type === "command")!;
    const context = { workspace, suite_dir: suite.suite_dir, before: snapshot, after: snapshot, protected_path_violations: [], unauthorized_path_violations: [], agent_result: { protocol_version: "1.0" as const, status: "completed" as const }, allow_command_checks: false };
    assert.equal(evaluateBenchmarkCheck(command, loadedTask, context).status, "skipped");
    const executed = evaluateBenchmarkCheck(command, loadedTask, { ...context, allow_command_checks: true });
    assert.equal(executed.status, "pass");
    assert.equal(executed.details?.verifier_workspace, "isolated_copy");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("command checks run in a disposable copy and cannot contaminate the scored workspace", () => {
  const root = temporaryDirectory();
  try {
    const suite = loadBenchmarkSuite(writeSuite(root, { commandCheck: true }));
    const loadedTask = suite.tasks[0]!;
    const workspace = path.join(root, "workspace");
    fs.cpSync(loadedTask.fixture_path, workspace, { recursive: true });
    const snapshot = snapshotWorkspace(workspace, 1024 * 1024);
    const command = loadedTask.task.checks.find((check) => check.type === "command")!;
    command.command = [process.execPath, "-e", "require('node:fs').writeFileSync('verifier-side-effect.txt','only-in-copy')"];
    const check = evaluateBenchmarkCheck(command, loadedTask, {
      workspace,
      suite_dir: suite.suite_dir,
      before: snapshot,
      after: snapshot,
      protected_path_violations: [],
      unauthorized_path_violations: [],
      agent_result: { protocol_version: "1.0", status: "completed" },
      allow_command_checks: true
    });
    assert.equal(check.status, "pass");
    assert.equal(fs.existsSync(path.join(workspace, "verifier-side-effect.txt")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("protected and unauthorized paths are hard score gates", () => {
  const root = temporaryDirectory();
  try {
    const suite = loadBenchmarkSuite(writeSuite(root));
    const loadedTask = suite.tasks[0]!;
    const workspace = path.join(root, "workspace");
    fs.cpSync(loadedTask.fixture_path, workspace, { recursive: true });
    const before = snapshotWorkspace(workspace, 1024 * 1024);
    fs.writeFileSync(path.join(workspace, "answer.txt"), "42\n");
    const after = snapshotWorkspace(workspace, 1024 * 1024);
    const context = { workspace, suite_dir: suite.suite_dir, before, after, agent_result: { protocol_version: "1.0" as const, status: "completed" as const }, allow_command_checks: false };
    assert.equal(scoreTask(loadedTask, { ...context, protected_path_violations: ["protected.txt"], unauthorized_path_violations: [] }, 1).passed, false);
    assert.equal(scoreTask(loadedTask, { ...context, protected_path_violations: [], unauthorized_path_violations: ["extra.txt"] }, 1).passed, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
