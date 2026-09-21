#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CommandAgent } from "../dist/packages/benchmark/src/agent.js";
import { compareBenchmarkReports } from "../dist/packages/benchmark/src/comparison.js";
import { assertPairedBenchmarkProfiles, benchmarkAgentProfileDescriptor, loadBenchmarkAgentProfile } from "../dist/packages/benchmark/src/profile.js";
import { runBenchmarkSuite, writeBenchmarkReport } from "../dist/packages/benchmark/src/runner.js";
import { loadBenchmarkSuite } from "../dist/packages/benchmark/src/suite.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const booleanFlags = new Set(["allow-command-checks", "require-all", "preserve-workspaces"]);

function usage() {
  return `Run a paired Emacs Operator benchmark experiment\n\n` +
    `Required:\n` +
    `  --suite FILE\n` +
    `  --baseline-profile FILE\n` +
    `  --candidate-profile FILE\n` +
    `  --baseline-command-json '["executable","arg"]'\n` +
    `  --candidate-command-json '["executable","arg"]'\n` +
    `  --output-dir DIR\n\n` +
    `Optional:\n` +
    `  --trials N --seed N --allow-command-checks --require-all --preserve-workspaces\n`;
}

function parse(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true, values };
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (booleanFlags.has(key)) { values[key] = true; continue; }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new TypeError(`Missing value for --${key}.`);
    values[key] = value;
  }
  return { help: false, values };
}

function required(values, key) {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`--${key} is required.`);
  return value;
}

function integer(values, key, fallback, minimum, maximum) {
  const raw = values[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`--${key} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}

function command(values, key) {
  let parsed;
  try { parsed = JSON.parse(required(values, key)); }
  catch { throw new TypeError(`--${key} must be a JSON string array.`); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || item.length === 0)) throw new TypeError(`--${key} must be a non-empty JSON string array.`);
  return parsed;
}

function atomicJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

const parsed = parse(process.argv.slice(2));
if (parsed.help) { process.stdout.write(usage()); process.exit(0); }
const values = parsed.values;
const suitePath = path.resolve(required(values, "suite"));
const outputDir = path.resolve(required(values, "output-dir"));
const baselineProfile = loadBenchmarkAgentProfile(required(values, "baseline-profile"));
const candidateProfile = loadBenchmarkAgentProfile(required(values, "candidate-profile"));
assertPairedBenchmarkProfiles(baselineProfile, candidateProfile);
const baselineCommand = command(values, "baseline-command-json");
const candidateCommand = command(values, "candidate-command-json");
const loadedSuite = loadBenchmarkSuite(suitePath);
const trials = integer(values, "trials", loadedSuite.suite.defaults?.trials ?? 1, 1, 100);
const seed = integer(values, "seed", 1, 0, 0xFFFFFFFF);
const allowCommandChecks = values["allow-command-checks"] === true;
const requireAllTasks = values["require-all"] === true;
const preserveWorkspaces = values["preserve-workspaces"] === true;
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

function createAgent(loadedProfile, agentCommand) {
  return new CommandAgent({
    id: loadedProfile.profile.id,
    version: loadedProfile.profile.model_version ?? loadedProfile.profile.revision,
    command: agentCommand,
    maxOutputBytes: loadedSuite.suite.defaults?.max_agent_output_bytes,
    descriptorMetadata: { profile: benchmarkAgentProfileDescriptor(loadedProfile) }
  });
}

const definitions = {
  baseline: { profile: baselineProfile, agent: createAgent(baselineProfile, baselineCommand), report: path.join(outputDir, "baseline.json") },
  candidate: { profile: candidateProfile, agent: createAgent(candidateProfile, candidateCommand), report: path.join(outputDir, "candidate.json") }
};
const order = seed % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
const reports = {};
for (const side of order) {
  const definition = definitions[side];
  const report = await runBenchmarkSuite(suitePath, definition.agent, {
    trials,
    seed,
    allow_command_checks: allowCommandChecks,
    require_all_tasks: requireAllTasks,
    preserve_workspaces: preserveWorkspaces,
    work_root: path.join(outputDir, "workspaces", side),
    output_path: definition.report
  });
  reports[side] = report;
}
const comparison = compareBenchmarkReports(reports.baseline, reports.candidate);
atomicJson(path.join(outputDir, "comparison.json"), comparison);
const experiment = {
  schema_version: "1.0",
  kind: "emacs_operator_paired_benchmark_experiment",
  created_at: new Date().toISOString(),
  suite: { id: loadedSuite.suite.id, revision: loadedSuite.suite.revision, digest: loadedSuite.digest },
  pairing_key: baselineProfile.profile.pairing_key,
  trials,
  seed,
  execution_order: order,
  command_checks_enabled: allowCommandChecks,
  profiles: {
    baseline: benchmarkAgentProfileDescriptor(baselineProfile),
    candidate: benchmarkAgentProfileDescriptor(candidateProfile)
  },
  reports: { baseline: "baseline.json", candidate: "candidate.json", comparison: "comparison.json" },
  summary: comparison.summary,
  caveat: "This comparison applies only to this suite revision, model configuration, prompt policy, tool profiles, environment, and sample. The CommandAgent process is not an operating-system sandbox."
};
atomicJson(path.join(outputDir, "experiment.json"), experiment);
writeBenchmarkReport(definitions.baseline.report, reports.baseline);
writeBenchmarkReport(definitions.candidate.report, reports.candidate);
process.stdout.write(`${JSON.stringify({ output_dir: outputDir, execution_order: order, summary: comparison.summary, reports_ok: { baseline: reports.baseline.ok, candidate: reports.candidate.ok } }, null, 2)}\n`);
process.exit(reports.baseline.ok && reports.candidate.ok && comparison.summary.paired_trials > 0 ? 0 : 1);
