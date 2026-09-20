#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(root, "artifacts", "benchmark-harness-sensitivity");
let outputDir = process.env.EMACS_OPERATOR_BENCHMARK_SENSITIVITY_DIR || defaultOutput;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--output-dir") {
    const value = args[++index];
    if (!value) throw new TypeError("--output-dir requires a value.");
    outputDir = path.resolve(value);
  } else if (args[index] === "--help" || args[index] === "-h") {
    process.stdout.write("Usage: node scripts/run-benchmark-sensitivity.mjs [--output-dir DIR]\n");
    process.exit(0);
  } else throw new TypeError(`Unexpected argument: ${args[index]}`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const execution = spawnSync(process.execPath, [
  "scripts/run-benchmark-pair.mjs",
  "--suite", "benchmarks/harness-sensitivity-v1/suite.json",
  "--baseline-profile", "benchmarks/profiles/naive-text.json",
  "--candidate-profile", "benchmarks/profiles/semantic-reference.json",
  "--baseline-command-json", JSON.stringify([process.execPath, path.join(root, "scripts", "benchmark-naive-agent.mjs")]),
  "--candidate-command-json", JSON.stringify([process.execPath, path.join(root, "scripts", "benchmark-reference-agent.mjs")]),
  "--output-dir", outputDir,
  "--trials", "1",
  "--seed", "17"
], {
  cwd: root,
  encoding: "utf8",
  timeout: 120_000,
  maxBuffer: 8 * 1024 * 1024
});
if (execution.status !== 0) {
  process.stderr.write(`${execution.stdout ?? ""}${execution.stderr ?? ""}`);
  process.exit(execution.status ?? 1);
}
const experiment = JSON.parse(fs.readFileSync(path.join(outputDir, "experiment.json"), "utf8"));
const baseline = JSON.parse(fs.readFileSync(path.join(outputDir, "baseline.json"), "utf8"));
const candidate = JSON.parse(fs.readFileSync(path.join(outputDir, "candidate.json"), "utf8"));
const passed = baseline.aggregate.trials_executed === 5
  && baseline.aggregate.trials_passed === 0
  && candidate.aggregate.trials_executed === 5
  && candidate.aggregate.trials_passed === 5
  && experiment.summary.paired_trials === 5
  && experiment.summary.candidate_wins === 5
  && experiment.summary.baseline_wins === 0;
const summary = {
  ok: passed,
  output_dir: outputDir,
  baseline_passed: baseline.aggregate.trials_passed,
  candidate_passed: candidate.aggregate.trials_passed,
  paired_trials: experiment.summary.paired_trials,
  candidate_wins: experiment.summary.candidate_wins,
  caveat: "This deterministic sensitivity probe validates benchmark plumbing and encoded failure modes. It is not evidence that an LLM, editor, or product is universally superior."
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(passed ? 0 : 1);
