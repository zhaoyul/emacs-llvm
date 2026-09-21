#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const reportPath = process.env.EMACS_OPERATOR_ALPHA11_REPORT
  || path.join(root, "artifacts", "alpha11-acceptance.json");
const results = [];

function outputTail(value, maximum = 6000) {
  return String(value ?? "").slice(-maximum);
}

function run(name, command, args = [], { required = true, cwd = root, env = {}, timeout = 300_000 } = {}) {
  const started = Date.now();
  const execution = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1", ...env },
    maxBuffer: 32 * 1024 * 1024,
    timeout
  });
  const item = {
    name,
    command: [command, ...args],
    exit_code: execution.status ?? (execution.signal ? 128 : 125),
    signal: execution.signal ?? null,
    ok: execution.status === 0,
    required,
    seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    output_tail: outputTail(`${execution.stdout ?? ""}${execution.stderr ?? ""}`),
    ...(execution.error ? { error: String(execution.error.message ?? execution.error) } : {})
  };
  results.push(item);
  return item;
}

function record(name, ok, details = {}, required = true) {
  const item = { name, ok: ok === true, required, ...details };
  results.push(item);
  return item;
}

function parseJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function shellScripts() {
  return readdirSync(path.join(root, "scripts"))
    .filter((name) => name.endsWith(".sh"))
    .sort()
    .map((name) => path.join("scripts", name));
}

function validateSchemas() {
  const schemaRoot = path.join(root, "schemas");
  const files = readdirSync(schemaRoot).filter((name) => name.endsWith(".json")).sort();
  const failures = [];
  for (const name of files) {
    try {
      const schema = parseJson(path.join(schemaRoot, name));
      if (typeof schema.$schema !== "string" || schema.$schema.length === 0) failures.push(`${name}: missing $schema`);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return record("json-schema-parse", failures.length === 0, { files: files.length, failures });
}

function benchmarkMarkers() {
  const runner = readFileSync(path.join(root, "packages", "benchmark", "src", "runner.ts"), "utf8");
  const scoring = readFileSync(path.join(root, "packages", "benchmark", "src", "scoring.ts"), "utf8");
  const workspace = readFileSync(path.join(root, "packages", "benchmark", "src", "workspace.ts"), "utf8");
  const comparison = readFileSync(path.join(root, "packages", "benchmark", "src", "comparison.ts"), "utf8");
  const agent = readFileSync(path.join(root, "packages", "benchmark", "src", "agent.ts"), "utf8");
  const profile = readFileSync(path.join(root, "packages", "benchmark", "src", "profile.ts"), "utf8");
  const checks = {
    fresh_fixture_per_trial: runner.includes("copyFixtureTree(loadedTask.fixture_path, workspace"),
    oracle_leak_guard: runner.includes("benchmarkRequestLeaksOracleData"),
    command_checks_opt_in: runner.includes("Suite contains command checks") && scoring.includes("command checks are disabled"),
    protected_path_gate: scoring.includes("protected_paths_clean") && workspace.includes("protectedPathViolations"),
    allowed_path_gate: scoring.includes("allowed_paths_clean") && workspace.includes("unauthorizedPathViolations"),
    private_trace_excluded: workspace.includes("BENCHMARK_PRIVATE_DIRECTORY"),
    paired_suite_digest_guard: comparison.includes("same suite id, revision, and digest"),
    paired_run_seed_guard: comparison.includes("same run-level seed"),
    stable_trial_seed: runner.includes("stableTrialSeed") && runner.includes("trial_seed: trialSeed"),
    bounded_bootstrap: comparison.includes("Math.min(20_000"),
    exact_stdio_protocol: agent.includes("stdout must contain exactly one JSON result"),
    redacted_command_descriptor: agent.includes("arguments_redacted") && agent.includes("command_digest"),
    disposable_verifier_copy: scoring.includes('verifier_workspace: "isolated_copy"'),
    paired_profile_controls: profile.includes("assertPairedBenchmarkProfiles") && profile.includes("Only the tool profile should differ"),
    secret_shaped_profile_rejection: profile.includes("FORBIDDEN_KEYS") && profile.includes("secret-bearing field")
  };
  return record("alpha11-integration-markers", Object.values(checks).every(Boolean), { checks });
}

function runHarnessSensitivity() {
  const stage = mkdtempSync(path.join(os.tmpdir(), "emacs-operator-alpha11-sensitivity-"));
  const outputDir = path.join(stage, "output");
  const started = Date.now();
  try {
    const args = [
      "scripts/run-benchmark-pair.mjs",
      "--suite", "benchmarks/harness-sensitivity-v1/suite.json",
      "--baseline-profile", "benchmarks/profiles/naive-text.json",
      "--candidate-profile", "benchmarks/profiles/semantic-reference.json",
      "--baseline-command-json", JSON.stringify([process.execPath, path.join(root, "scripts", "benchmark-naive-agent.mjs")]),
      "--candidate-command-json", JSON.stringify([process.execPath, path.join(root, "scripts", "benchmark-reference-agent.mjs")]),
      "--output-dir", outputDir,
      "--trials", "1",
      "--seed", "17"
    ];
    const execution = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024
    });
    if (execution.status !== 0) {
      return record("benchmark-harness-sensitivity", false, {
        seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
        exit_code: execution.status,
        output_tail: outputTail(`${execution.stdout ?? ""}${execution.stderr ?? ""}`)
      });
    }
    const experiment = parseJson(path.join(outputDir, "experiment.json"));
    const baseline = parseJson(path.join(outputDir, "baseline.json"));
    const candidate = parseJson(path.join(outputDir, "candidate.json"));
    const summary = experiment.summary;
    const ok = baseline.aggregate.trials_executed === 5
      && baseline.aggregate.trials_passed === 0
      && candidate.aggregate.trials_executed === 5
      && candidate.aggregate.trials_passed === 5
      && summary.paired_trials === 5
      && summary.candidate_wins === 5
      && summary.baseline_wins === 0;
    return record("benchmark-harness-sensitivity", ok, {
      seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
      baseline_passed: baseline.aggregate.trials_passed,
      candidate_passed: candidate.aggregate.trials_passed,
      paired_trials: summary.paired_trials,
      candidate_wins: summary.candidate_wins,
      caveat: "This deterministic probe validates harness sensitivity only. It is not an LLM or product comparison."
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function smokeExtractedBundle(bundlePath) {
  const stage = mkdtempSync(path.join(os.tmpdir(), "emacs-operator-alpha11-mcpb-"));
  try {
    const extraction = spawnSync(
      "python3",
      ["-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", bundlePath, stage],
      { encoding: "utf8", timeout: 30_000 }
    );
    if (extraction.status !== 0) {
      return record("mcpb-extracted-server-smoke", false, { reason: outputTail(extraction.stderr) });
    }
    const entry = path.join(stage, "server", "packages", "mcp-server", "src", "server.js");
    if (!existsSync(entry)) return record("mcpb-extracted-server-smoke", false, { reason: "server entry point is missing" });
    if (existsSync(path.join(stage, "server", "packages", "benchmark"))) {
      return record("mcpb-extracted-server-smoke", false, { reason: "development-only benchmark package leaked into MCPB" });
    }

    const child = spawn(process.execPath, [entry], { cwd: stage, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "";
    let stderr = "";
    const responses = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) continue;
        try { responses.push(JSON.parse(line)); } catch { /* captured in final failure */ }
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "emacs_health", arguments: {} } })}\n`);
    const deadline = Date.now() + 5000;
    while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    const initialize = responses.find((response) => response.id === 1);
    const health = responses.find((response) => response.id === 2);
    const initializeVersion = initialize?.result?.serverInfo?.version ?? null;
    const healthOk = health?.result?.structuredContent?.ok === true;
    return record("mcpb-extracted-server-smoke", initializeVersion === version && healthOk, {
      initialize_version: initializeVersion,
      health_ok: healthOk,
      benchmark_package_excluded: true,
      stderr_tail: outputTail(stderr, 2000)
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function writeSyntheticBenchmarkFixture(stage) {
  const suiteDir = path.join(stage, "suite");
  const fixtureDir = path.join(suiteDir, "fixture");
  mkdirSync(fixtureDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(suiteDir, "prompt.md"), "Change answer.txt from 40 to 42. Preserve protected.txt.\n", { mode: 0o600 });
  writeFileSync(path.join(fixtureDir, "answer.txt"), "40\n", { mode: 0o600 });
  writeFileSync(path.join(fixtureDir, "protected.txt"), "immutable\n", { mode: 0o600 });
  const suite = {
    schema_version: "1.0",
    id: "alpha11-harness-smoke",
    revision: "1",
    title: "Alpha.11 benchmark harness smoke",
    defaults: { timeout_ms: 10_000, trials: 2, pass_threshold: 1, max_workspace_bytes: 1_048_576, max_agent_output_bytes: 65_536 },
    tasks: [{
      id: "replace-answer",
      title: "Replace answer",
      domain: "mixed",
      category: "repair",
      difficulty: "small",
      prompt_file: "prompt.md",
      fixture_dir: "fixture",
      allowed_paths: ["answer.txt"],
      protected_paths: ["protected.txt"],
      checks: [
        { id: "answer", type: "exact_text", path: "answer.txt", expected_text: "42\n", weight: 5 },
        { id: "protected", type: "file_unchanged", path: "protected.txt", weight: 1 }
      ]
    }]
  };
  const suitePath = path.join(suiteDir, "suite.json");
  writeFileSync(suitePath, `${JSON.stringify(suite, null, 2)}\n`, { mode: 0o600 });

  const agentPath = path.join(stage, "candidate-agent.mjs");
  writeFileSync(agentPath, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
fs.writeFileSync(path.join(request.workspace, "answer.txt"), "42\\n", "utf8");
fs.mkdirSync(path.dirname(request.trace_path), { recursive: true, mode: 0o700 });
const events = [
  { sequence: 1, at_ms: 0, kind: "agent_started" },
  { sequence: 2, at_ms: 1, kind: "tool_call", tool: "filesystem.write", operation: "replace_answer", channel: "filesystem", mutation: true },
  { sequence: 3, at_ms: 2, kind: "tool_result", tool: "filesystem.write", operation: "replace_answer", channel: "filesystem", ok: true },
  { sequence: 4, at_ms: 3, kind: "agent_finished", ok: true }
];
fs.writeFileSync(request.trace_path, events.map((event) => JSON.stringify(event)).join("\\n") + "\\n", "utf8");
process.stdout.write(JSON.stringify({ protocol_version: "1.0", status: "completed", summary: "Synthetic candidate changed the allowed file.", usage: { input_tokens: 10, output_tokens: 5, tool_calls: 1, mutations: 1, rollbacks: 0 } }) + "\\n");
`, { mode: 0o700 });
  return { suitePath, agentPath };
}

function runBenchmarkSmoke() {
  const stage = mkdtempSync(path.join(os.tmpdir(), "emacs-operator-alpha11-benchmark-"));
  const started = Date.now();
  try {
    const { suitePath, agentPath } = writeSyntheticBenchmarkFixture(stage);
    const cli = path.join(root, "dist", "packages", "benchmark", "src", "cli.js");
    const baselinePath = path.join(stage, "baseline.json");
    const candidatePath = path.join(stage, "candidate.json");
    const comparisonPath = path.join(stage, "comparison.json");
    const baseline = spawnSync(process.execPath, [cli, "run", "--suite", suitePath, "--agent-id", "noop-baseline", "--noop", "--trials", "2", "--seed", "11", "--output", baselinePath], { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const candidateCommand = JSON.stringify([process.execPath, agentPath]);
    const candidate = spawnSync(process.execPath, [cli, "run", "--suite", suitePath, "--agent-id", "synthetic-candidate", "--agent-command-json", candidateCommand, "--trials", "2", "--seed", "11", "--output", candidatePath], { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const comparison = spawnSync(process.execPath, [cli, "compare", "--baseline", baselinePath, "--candidate", candidatePath, "--output", comparisonPath], { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    if (baseline.status !== 0 || candidate.status !== 0 || comparison.status !== 0) {
      return record("benchmark-end-to-end-smoke", false, {
        seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
        baseline_exit: baseline.status,
        candidate_exit: candidate.status,
        comparison_exit: comparison.status,
        output_tail: outputTail(`${baseline.stderr ?? ""}${candidate.stderr ?? ""}${comparison.stderr ?? ""}`)
      });
    }
    const baselineReport = parseJson(baselinePath);
    const candidateReport = parseJson(candidatePath);
    const comparisonReport = parseJson(comparisonPath);
    const ok = baselineReport.aggregate.trials_executed === 2
      && baselineReport.aggregate.trials_passed === 0
      && candidateReport.aggregate.trials_executed === 2
      && candidateReport.aggregate.trials_passed === 2
      && candidateReport.aggregate.protected_path_violations === 0
      && candidateReport.aggregate.unauthorized_path_violations === 0
      && comparisonReport.summary.paired_trials === 2
      && comparisonReport.summary.candidate_wins === 2
      && comparisonReport.summary.baseline_wins === 0;
    return record("benchmark-end-to-end-smoke", ok, {
      seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
      baseline: baselineReport.aggregate,
      candidate: candidateReport.aggregate,
      comparison: comparisonReport.summary
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

run("version-consistency", process.execPath, ["scripts/sync-version.mjs", "--check"]);
run("elisp-lexical-structure", "python3", ["scripts/check-elisp-structure.py"]);
run("typescript-typecheck", "npm", ["run", "typecheck"]);
run("typescript-main-tests", "npm", ["run", "test:ts"]);

const intelligenceTests = readdirSync(path.join(root, "packages", "refactor-intelligence", "test"))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join("packages", "refactor-intelligence", "test", name));
run("refactor-intelligence-tests", process.execPath, ["--test", ...intelligenceTests]);
run("swift-portable-tests", "swift", ["test", "--package-path", "apps/macos-host"]);
run("shell-syntax", "bash", ["-n", ...shellScripts()]);
validateSchemas();
benchmarkMarkers();
run("benchmark-corpus-validation", "npm", ["run", "benchmark:validate"]);
runBenchmarkSmoke();
runHarnessSensitivity();

const emacsProbe = spawnSync("emacs", ["--version"], { encoding: "utf8" });
if (emacsProbe.status === 0) run("ert", "npm", ["run", "test:elisp"]);
else record("ert", false, { status: "not_run", reason: "GNU Emacs 29+ is unavailable in this environment." }, false);

const bundlePath = path.join(root, "dist", `emacs-operator-${version}.mcpb`);
run("mcpb-package", "bash", ["scripts/package-mcpb.sh", bundlePath]);
run("mcpb-zip-integrity", "python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); print('files=%d'%len(z.namelist())); assert bad is None, bad; assert not any(n.startswith('server/packages/benchmark/') for n in z.namelist()), 'benchmark package leaked into MCPB'", bundlePath]);
await smokeExtractedBundle(bundlePath);

const requiredOk = results.filter((item) => item.required).every((item) => item.ok === true);
const benchmarkSuite = parseJson(path.join(root, "benchmarks", "lisp-org-v1", "suite.json"));
const report = {
  schema_version: "1.0",
  kind: "emacs_operator_alpha11_acceptance",
  version,
  suite: "alpha11",
  ok: requiredOk,
  generated_at: new Date().toISOString(),
  benchmark: {
    suite_id: benchmarkSuite.id,
    suite_revision: benchmarkSuite.revision,
    task_count: benchmarkSuite.tasks.length,
    real_language_runtime: emacsProbe.status === 0 ? "partially_available" : "not_run_in_this_environment",
    interpretation: "Portable acceptance validates the benchmark harness and corpus integrity. It does not claim a measured Emacs Operator advantage. Real paired agent trials must be run separately on a controlled machine."
  },
  runtime_acceptance: {
    emacs_ert: emacsProbe.status === 0 ? "executed" : "not_run",
    macos_native: process.platform === "darwin" ? "not_part_of_alpha11_portable_suite" : "not_run_on_non_macos"
  },
  results
};
mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
process.exit(requiredOk ? 0 : 1);
