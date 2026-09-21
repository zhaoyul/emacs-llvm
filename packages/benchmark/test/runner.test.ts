import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { InProcessAgent, NoopAgent } from "../src/agent.js";
import { loadBenchmarkReport, runBenchmarkSuite } from "../src/runner.js";
import { temporaryDirectory, writeSuite } from "./helpers.js";

test("runner gives every trial a fresh fixture and independently scores it", async () => {
  const root = temporaryDirectory();
  const seen: string[] = [];
  const trialSeeds: number[] = [];
  try {
    const suite = writeSuite(root, { allowedPaths: ["answer.txt"] });
    const reportPath = path.join(root, "report.json");
    const agent = new InProcessAgent("editor", async (request) => {
      const file = path.join(request.workspace, "answer.txt");
      seen.push(fs.readFileSync(file, "utf8"));
      trialSeeds.push(request.trial_seed);
      fs.writeFileSync(file, "42\n");
      return { protocol_version: "1.0", status: "completed", usage: { tool_calls: 1, mutations: 1 }, events: [{ at_ms: 1, kind: "tool_call", tool: "filesystem.write", channel: "filesystem", mutation: true }, { at_ms: 2, kind: "tool_result", tool: "filesystem.write", channel: "filesystem", ok: true }] };
    });
    const report = await runBenchmarkSuite(suite, agent, { trials: 2, seed: 7, output_path: reportPath });
    assert.deepEqual(seen, ["40\n", "40\n"]);
    assert.equal(trialSeeds.length, 2);
    assert.notEqual(trialSeeds[0], trialSeeds[1]);
    assert.deepEqual(report.trials.map((trial) => trial.trial_seed), trialSeeds);
    assert.equal(report.aggregate.trials_executed, 2);
    assert.equal(report.aggregate.trials_passed, 2);
    assert.equal(report.aggregate.pass_rate, 1);
    assert.equal(report.ok, true);
    assert.equal(fs.existsSync(reportPath), true);
    assert.equal(loadBenchmarkReport(reportPath).run_id, report.run_id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("runner fails trials that touch protected or unauthorized paths", async () => {
  const root = temporaryDirectory();
  try {
    const suite = writeSuite(root, { protectedPaths: ["protected.txt"], allowedPaths: ["answer.txt"] });
    const agent = new InProcessAgent("reckless", async (request) => {
      fs.writeFileSync(path.join(request.workspace, "answer.txt"), "42\n");
      fs.writeFileSync(path.join(request.workspace, "protected.txt"), "changed\n");
      fs.writeFileSync(path.join(request.workspace, "extra.txt"), "extra\n");
      return { protocol_version: "1.0", status: "completed" };
    });
    const report = await runBenchmarkSuite(suite, agent);
    assert.equal(report.trials[0]?.score.passed, false);
    assert.deepEqual(report.trials[0]?.protected_path_violations, ["protected.txt"]);
    assert.deepEqual(report.trials[0]?.unauthorized_path_violations, ["extra.txt", "protected.txt"]);
    assert.equal(report.aggregate.protected_path_violations, 1);
    assert.equal(report.aggregate.unauthorized_path_violations, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("runner requires explicit permission for command checks", async () => {
  const root = temporaryDirectory();
  try {
    const suite = writeSuite(root, { commandCheck: true });
    await assert.rejects(runBenchmarkSuite(suite, new NoopAgent()), /command checks/iu);
    const report = await runBenchmarkSuite(suite, new NoopAgent(), { allow_command_checks: true });
    assert.equal(report.aggregate.trials_executed, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("runner records unavailable tasks without pretending they ran", async () => {
  const root = temporaryDirectory();
  try {
    const suite = writeSuite(root, { requirements: { executables: ["definitely-not-an-emacs-operator-test-executable"] } });
    const report = await runBenchmarkSuite(suite, new NoopAgent());
    assert.equal(report.tasks[0]?.available, false);
    assert.equal(report.trials.length, 0);
    assert.equal(report.ok, false);
    assert.equal(report.errors.some((error) => error.code === "E_NO_EXECUTED_TRIALS"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("runner request excludes oracle fields and reports the cooperative isolation boundary", async () => {
  const root = temporaryDirectory();
  let observed: unknown;
  try {
    const suite = writeSuite(root, { allowedPaths: ["answer.txt"] });
    const report = await runBenchmarkSuite(suite, new InProcessAgent("observer", async (request) => {
      observed = structuredClone(request);
      fs.writeFileSync(path.join(request.workspace, "answer.txt"), "42\n");
      return { protocol_version: "1.0", status: "completed" };
    }));
    const { benchmarkRequestLeaksOracleData } = await import("../src/runner.js");
    assert.equal(benchmarkRequestLeaksOracleData(observed), false);
    assert.equal(JSON.stringify(observed).includes("expected_text"), false);
    assert.equal(report.integrity.oracle_fields_excluded_from_request, true);
    assert.equal(report.integrity.agent_process_os_sandboxed, false);
    assert.equal(report.integrity.command_checks_use_disposable_workspace_copy, true);
    assert.equal(report.integrity.command_process_os_sandboxed, false);
    assert.match(report.integrity.note, /cooperative experimental control/iu);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
