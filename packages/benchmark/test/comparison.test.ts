import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { InProcessAgent, NoopAgent } from "../src/agent.js";
import { compareBenchmarkReports } from "../src/comparison.js";
import { runBenchmarkSuite } from "../src/runner.js";
import { temporaryDirectory, writeSuite } from "./helpers.js";

test("paired comparison reports candidate wins without universal claims", async () => {
  const root = temporaryDirectory();
  try {
    const suite = writeSuite(root, { allowedPaths: ["answer.txt"] });
    const baseline = await runBenchmarkSuite(suite, new NoopAgent("baseline"), { trials: 3, seed: 11 });
    const candidate = await runBenchmarkSuite(suite, new InProcessAgent("candidate", async (request) => {
      fs.writeFileSync(path.join(request.workspace, "answer.txt"), "42\n");
      return { protocol_version: "1.0", status: "completed" };
    }), { trials: 3, seed: 11 });
    const comparison = compareBenchmarkReports(baseline, candidate, 500);
    assert.equal(comparison.summary.paired_trials, 3);
    assert.equal(comparison.summary.candidate_wins, 3);
    assert.equal(comparison.summary.baseline_wins, 0);
    assert.equal(comparison.summary.candidate_advantage, 1);
    assert.deepEqual(comparison.pairs.map((pair) => pair.trial_seed), baseline.trials.map((trial) => trial.trial_seed));
    assert.match(comparison.interpretation, /this exact suite/iu);
    assert.match(comparison.interpretation, /does not establish a universal advantage/iu);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("comparison rejects different run-level seeds", async () => {
  const root = temporaryDirectory();
  try {
    const suite = writeSuite(root);
    const left = await runBenchmarkSuite(suite, new NoopAgent("left"), { seed: 1 });
    const right = await runBenchmarkSuite(suite, new NoopAgent("right"), { seed: 2 });
    assert.throws(() => compareBenchmarkReports(left, right), /same run-level seed/iu);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("comparison rejects different suite digests", async () => {
  const root = temporaryDirectory();
  try {
    const suite = writeSuite(root);
    const left = await runBenchmarkSuite(suite, new NoopAgent("left"));
    const right = structuredClone(left);
    right.suite.digest = "different";
    assert.throws(() => compareBenchmarkReports(left, right), /same suite/iu);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
