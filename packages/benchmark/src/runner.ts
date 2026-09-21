import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EMACS_OPERATOR_VERSION } from "../../protocol/src/version.generated.js";
import { normalizeAgentResult } from "./agent.js";
import { sha256Bytes } from "./hash.js";
import { taskAvailability } from "./environment.js";
import { scoreTask } from "./scoring.js";
import { loadBenchmarkSuite, suiteUsesCommandChecks } from "./suite.js";
import { readTraceFile, summarizeTrace } from "./trace.js";
import { copyFixtureTree, diffWorkspace, protectedPathViolations, unauthorizedPathViolations, snapshotWorkspace, BENCHMARK_PRIVATE_DIRECTORY } from "./workspace.js";
import type { BenchmarkAgent, BenchmarkAgentResult, BenchmarkReport, BenchmarkRunOptions, BenchmarkScore, BenchmarkTaskSummary, BenchmarkTrialReport, LoadedBenchmarkTask, WorkspaceDiffSummary, WorkspaceSnapshot } from "./types.js";

function safeSegment(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 128) || "item"; }
function numeric(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new TypeError(`Expected integer between ${minimum} and ${maximum}.`);
  return result;
}
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
function shuffled<T>(values: T[], seed: number): T[] {
  const output = [...values];
  const random = mulberry32(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target]!, output[index]!];
  }
  return output;
}
function mean(values: number[]): number | null { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint]! : (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
}
function newRunId(suiteDigest: string, agentId: string, seed: number): string {
  return `run_${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}_${sha256Bytes(`${suiteDigest}\0${agentId}\0${seed}\0${Math.random()}`).slice(0, 12)}`;
}
function stableTrialSeed(suiteDigest: string, taskId: string, trial: number, runSeed: number): number {
  return Number.parseInt(sha256Bytes(`${suiteDigest}\0${taskId}\0${trial}\0${runSeed}`).slice(0, 8), 16) >>> 0;
}
function atomicJson(file: string, value: unknown): void {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function writeBenchmarkReport(file: string, report: BenchmarkReport): void { atomicJson(file, report); }
export function loadBenchmarkReport(file: string): BenchmarkReport {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  if (!parsed || parsed.schema_version !== "1.0" || parsed.kind !== "emacs_operator_benchmark_report") throw new TypeError("File is not an Emacs Operator benchmark report v1.0.");
  if (!Number.isInteger(parsed.options?.seed) || parsed.options.seed < 0 || parsed.options.seed > 0xFFFFFFFF) throw new TypeError("Benchmark report options.seed must be an unsigned 32-bit integer.");
  if (!Array.isArray(parsed.trials) || parsed.trials.some((trial: any) => !Number.isInteger(trial?.trial_seed) || trial.trial_seed < 0 || trial.trial_seed > 0xFFFFFFFF)) throw new TypeError("Benchmark report trials must contain unsigned 32-bit trial_seed values.");
  return parsed as BenchmarkReport;
}

function harnessScore(task: LoadedBenchmarkTask, threshold: number, message: string, agentCompleted = false): BenchmarkScore {
  return {
    score: 0,
    threshold,
    passed_weight: 0,
    total_weight: 1,
    required_checks_passed: false,
    agent_completed: agentCompleted,
    protected_paths_clean: false,
    allowed_paths_clean: false,
    passed: false,
    checks: [{ id: "benchmark_harness", type: "harness", status: "error", required: true, weight: 1, duration_ms: 0, details: { error: message } }]
  };
}

async function invokeWithTimeout(agent: BenchmarkAgent, request: any, timeoutMs: number): Promise<{ result: BenchmarkAgentResult; timedOut: boolean; error: Error | null }> {
  const controller = new AbortController();
  let timer: any;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(`Agent exceeded timeout of ${timeoutMs} ms.`)); }, timeoutMs);
  });
  try {
    const raw = await Promise.race([agent.run(request, controller.signal), timeout]);
    return { result: normalizeAgentResult(raw), timedOut: false, error: null };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      result: { protocol_version: "1.0", status: timedOut ? "timeout" : "protocol_error", summary: timedOut ? `Agent exceeded timeout of ${timeoutMs} ms.` : "Agent invocation failed." },
      timedOut,
      error: error instanceof Error ? error : new Error(String(error))
    };
  } finally {
    clearTimeout(timer);
  }
}

function emptySnapshot(): WorkspaceSnapshot { return { digest: sha256Bytes(""), total_bytes: 0, files: [] }; }

async function runTrial(args: {
  loaded: ReturnType<typeof loadBenchmarkSuite>;
  loadedTask: LoadedBenchmarkTask;
  agent: BenchmarkAgent;
  runId: string;
  trial: number;
  runSeed: number;
  timeoutMs: number;
  maxWorkspaceBytes: number;
  threshold: number;
  runRoot: string;
  allowCommandChecks: boolean;
  preserveWorkspaces: boolean;
}): Promise<BenchmarkTrialReport> {
  const { loaded, loadedTask, agent, runId, trial, runSeed, timeoutMs, maxWorkspaceBytes, threshold, runRoot, allowCommandChecks, preserveWorkspaces } = args;
  const trialSeed = stableTrialSeed(loaded.digest, loadedTask.task.id, trial, runSeed);
  const trialId = `${safeSegment(loadedTask.task.id)}-t${trial}`;
  const trialRoot = path.join(runRoot, trialId);
  const workspace = path.join(trialRoot, "workspace");
  const privateDir = path.join(workspace, BENCHMARK_PRIVATE_DIRECTORY);
  const tracePath = path.join(privateDir, "trace.jsonl");
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let before = emptySnapshot();
  let after = emptySnapshot();
  let agentResult: BenchmarkAgentResult = { protocol_version: "1.0", status: "protocol_error", summary: "Agent was not invoked." };
  let invocationError: Error | null = null;
  let timedOut = false;
  let violations: string[] = [];
  let unauthorized: string[] = [];
  let score = harnessScore(loadedTask, threshold, "Trial did not start.");
  let diff: WorkspaceDiffSummary = { added: [], modified: [], deleted: [], unchanged: 0, changed_files: 0, bytes_before: 0, bytes_after: 0 };
  let status: BenchmarkTrialReport["status"] = "harness_error";

  try {
    fs.rmSync(trialRoot, { recursive: true, force: true });
    fs.mkdirSync(trialRoot, { recursive: true, mode: 0o700 });
    copyFixtureTree(loadedTask.fixture_path, workspace, maxWorkspaceBytes);
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    before = snapshotWorkspace(workspace, maxWorkspaceBytes);
    const request = {
      protocol_version: "1.0" as const,
      run_id: runId,
      suite_id: loaded.suite.id,
      suite_revision: loaded.suite.revision,
      suite_digest: loaded.digest,
      task_id: loadedTask.task.id,
      task_digest: loadedTask.digest,
      trial,
      trial_seed: trialSeed,
      prompt: loadedTask.prompt,
      workspace,
      timeout_ms: timeoutMs,
      trace_path: tracePath,
      metadata: {
        domain: loadedTask.task.domain,
        category: loadedTask.task.category,
        difficulty: loadedTask.task.difficulty,
        tags: loadedTask.task.tags ?? []
      }
    };
    if (benchmarkRequestLeaksOracleData(request)) throw new Error(`Benchmark request for ${loadedTask.task.id} leaks oracle data.`);
    const invocation = await invokeWithTimeout(agent, request, timeoutMs);
    agentResult = invocation.result;
    invocationError = invocation.error;
    timedOut = invocation.timedOut;
    after = snapshotWorkspace(workspace, maxWorkspaceBytes);
    diff = diffWorkspace(before, after);
    violations = protectedPathViolations(diff, loadedTask.task.protected_paths ?? []);
    unauthorized = unauthorizedPathViolations(diff, loadedTask.task.allowed_paths ?? []);
    score = scoreTask(loadedTask, { workspace, suite_dir: loaded.suite_dir, before, after, protected_path_violations: violations, unauthorized_path_violations: unauthorized, agent_result: agentResult, allow_command_checks: allowCommandChecks }, threshold);
    status = score.passed ? "passed" : timedOut ? "timeout" : agentResult.status === "completed" ? "failed" : "agent_error";
  } catch (error) {
    invocationError = error instanceof Error ? error : new Error(String(error));
    try { after = fs.existsSync(workspace) ? snapshotWorkspace(workspace, maxWorkspaceBytes) : emptySnapshot(); } catch { after = emptySnapshot(); }
    try { diff = diffWorkspace(before, after); violations = protectedPathViolations(diff, loadedTask.task.protected_paths ?? []); unauthorized = unauthorizedPathViolations(diff, loadedTask.task.allowed_paths ?? []); } catch { /* retain empty diff */ }
    score = harnessScore(loadedTask, threshold, invocationError.message, agentResult.status === "completed");
    status = "harness_error";
  }

  let traceEvents: any[] = [];
  try { traceEvents = readTraceFile(tracePath); } catch { traceEvents = []; }
  if (traceEvents.length === 0) traceEvents = agentResult.events ?? [];
  const traceMetrics = summarizeTrace(traceEvents, agentResult.usage);
  const durationMs = Date.now() - started;
  const retainedPath = preserveWorkspaces ? workspace : undefined;
  const report: BenchmarkTrialReport = {
    trial_id: trialId,
    task_id: loadedTask.task.id,
    task_digest: loadedTask.digest,
    trial,
    trial_seed: trialSeed,
    status,
    agent_status: agentResult.status,
    ...(agentResult.summary !== undefined ? { agent_summary: agentResult.summary } : {}),
    started_at: startedAt,
    duration_ms: durationMs,
    workspace_before: { digest: before.digest, total_bytes: before.total_bytes, files: before.files.length },
    workspace_after: { digest: after.digest, total_bytes: after.total_bytes, files: after.files.length },
    workspace_diff: diff,
    protected_path_violations: violations,
    unauthorized_path_violations: unauthorized,
    workspace_retained: preserveWorkspaces,
    ...(retainedPath ? { workspace_path: retainedPath } : {}),
    score,
    metrics: { duration_ms: durationMs, ...traceMetrics },
    ...(invocationError ? { error: { code: timedOut ? "E_AGENT_TIMEOUT" : status === "harness_error" ? "E_BENCHMARK_HARNESS" : "E_AGENT_PROTOCOL", message: invocationError.message.slice(0, 8192) } } : {})
  };
  if (!preserveWorkspaces) fs.rmSync(trialRoot, { recursive: true, force: true });
  return report;
}

export function benchmarkRequestLeaksOracleData(request: unknown): boolean {
  const forbidden = new Set(["checks", "expected", "expected_file", "oracle", "oracle_result", "protected_paths", "allowed_paths", "suite_dir", "fixture_path"]);
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(visit);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) if (forbidden.has(key.toLowerCase()) || visit(child)) return true;
    return false;
  };
  return visit(request);
}

export async function runBenchmarkSuite(suitePath: string, agent: BenchmarkAgent, options: BenchmarkRunOptions = {}): Promise<BenchmarkReport> {
  const loaded = loadBenchmarkSuite(suitePath);
  const allowCommandChecks = options.allow_command_checks ?? false;
  if (suiteUsesCommandChecks(loaded) && !allowCommandChecks) throw new TypeError("Suite contains command checks. Re-run with allow_command_checks=true after reviewing the suite.");
  const trialsRequested = numeric(options.trials, loaded.suite.defaults?.trials ?? 1, 1, 100);
  const seed = numeric(options.seed, 1, 0, 0xFFFFFFFF);
  const preserveWorkspaces = options.preserve_workspaces ?? false;
  const requireAllTasks = options.require_all_tasks ?? false;
  const maxWorkspaceBytes = loaded.suite.defaults?.max_workspace_bytes ?? 16 * 1024 * 1024;
  const runId = newRunId(loaded.digest, agent.id, seed);
  const runRoot = path.resolve(options.work_root ?? path.join(os.tmpdir(), "emacs-operator-benchmark", runId));
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const errors: Array<{ code: string; message: string }> = [];
  const requestedIds = options.task_ids ? new Set(options.task_ids) : null;
  if (requestedIds) {
    const known = new Set(loaded.tasks.map(({ task }) => task.id));
    for (const id of requestedIds) if (!known.has(id)) throw new TypeError(`Unknown benchmark task id: ${id}`);
  }
  const selected = loaded.tasks.filter(({ task }) => !requestedIds || requestedIds.has(task.id));
  if (selected.length === 0) throw new TypeError("No benchmark tasks were selected.");
  const ordered = shuffled(selected, seed);
  const trials: BenchmarkTrialReport[] = [];
  const taskSummaries: BenchmarkTaskSummary[] = [];

  for (const loadedTask of ordered) {
    const availability = taskAvailability(loadedTask.task);
    const reports: BenchmarkTrialReport[] = [];
    if (!availability.available) {
      if (requireAllTasks) errors.push({ code: "E_TASK_UNAVAILABLE", message: `${loadedTask.task.id}: ${availability.reasons.join("; ")}` });
    } else {
      for (let trial = 1; trial <= trialsRequested; trial += 1) {
        const timeoutMs = loadedTask.task.timeout_ms ?? loaded.suite.defaults?.timeout_ms ?? 120_000;
        const threshold = loadedTask.task.pass_threshold ?? loaded.suite.defaults?.pass_threshold ?? 1;
        const report = await runTrial({ loaded, loadedTask, agent, runId, trial, runSeed: seed, timeoutMs, maxWorkspaceBytes, threshold, runRoot, allowCommandChecks, preserveWorkspaces });
        reports.push(report);
        trials.push(report);
        if (report.status === "harness_error") errors.push({ code: "E_BENCHMARK_HARNESS", message: `${loadedTask.task.id} trial ${trial}: ${report.error?.message ?? "harness error"}` });
      }
    }
    const scores = reports.map((report) => report.score.score);
    const durations = reports.map((report) => report.duration_ms);
    const passed = reports.filter((report) => report.score.passed).length;
    taskSummaries.push({
      task_id: loadedTask.task.id,
      task_digest: loadedTask.digest,
      title: loadedTask.task.title,
      domain: loadedTask.task.domain,
      category: loadedTask.task.category,
      difficulty: loadedTask.task.difficulty,
      available: availability.available,
      unavailable_reasons: availability.reasons,
      trials_requested: trialsRequested,
      trials_executed: reports.length,
      passed,
      failed: reports.length - passed,
      pass_rate: reports.length ? passed / reports.length : null,
      mean_score: mean(scores),
      mean_duration_ms: mean(durations)
    });
  }

  if (trials.length === 0) errors.push({ code: "E_NO_EXECUTED_TRIALS", message: "No trials were executed because all selected tasks were unavailable." });
  const passedTrials = trials.filter((trial) => trial.score.passed).length;
  const tokenInputs = trials.map((trial) => trial.metrics.input_tokens).filter((value): value is number => value !== null);
  const tokenOutputs = trials.map((trial) => trial.metrics.output_tokens).filter((value): value is number => value !== null);
  const aggregate = {
    tasks_total: taskSummaries.length,
    tasks_available: taskSummaries.filter((task) => task.available).length,
    tasks_unavailable: taskSummaries.filter((task) => !task.available).length,
    trials_requested: taskSummaries.length * trialsRequested,
    trials_executed: trials.length,
    trials_passed: passedTrials,
    trials_failed: trials.length - passedTrials,
    pass_rate: trials.length ? passedTrials / trials.length : null,
    mean_score: mean(trials.map((trial) => trial.score.score)),
    median_score: median(trials.map((trial) => trial.score.score)),
    mean_duration_ms: mean(trials.map((trial) => trial.duration_ms)),
    mean_tool_calls: mean(trials.map((trial) => trial.metrics.tool_calls)),
    mean_mutations: mean(trials.map((trial) => trial.metrics.mutations)),
    mean_rollbacks: mean(trials.map((trial) => trial.metrics.rollbacks)),
    total_input_tokens: tokenInputs.length ? tokenInputs.reduce((sum, value) => sum + value, 0) : null,
    total_output_tokens: tokenOutputs.length ? tokenOutputs.reduce((sum, value) => sum + value, 0) : null,
    protected_path_violations: trials.reduce((sum, trial) => sum + trial.protected_path_violations.length, 0),
    unauthorized_path_violations: trials.reduce((sum, trial) => sum + trial.unauthorized_path_violations.length, 0)
  };
  const report: BenchmarkReport = {
    schema_version: "1.0",
    kind: "emacs_operator_benchmark_report",
    runner_version: EMACS_OPERATOR_VERSION,
    run_id: runId,
    created_at: new Date().toISOString(),
    suite: { id: loaded.suite.id, revision: loaded.suite.revision, title: loaded.suite.title, digest: loaded.digest },
    agent: { id: agent.id, ...(agent.version ? { version: agent.version } : {}), mode: agent.mode, ...(agent.descriptor ? { descriptor: agent.descriptor() } : {}) },
    options: { trials: trialsRequested, seed, allow_command_checks: allowCommandChecks, require_all_tasks: requireAllTasks, preserve_workspaces: preserveWorkspaces },
    environment: { platform: process.platform, arch: process.arch, node: process.version, cpus: Array.isArray(os.cpus()) ? os.cpus().length : null },
    integrity: {
      oracle_fields_excluded_from_request: true,
      agent_process_os_sandboxed: false,
      command_checks_explicitly_enabled: allowCommandChecks,
      command_checks_use_disposable_workspace_copy: true,
      command_process_os_sandboxed: false,
      note: "The request protocol excludes checks and verifier paths. Command checks run against a disposable workspace copy, but neither the agent process nor verifier process is an operating-system sandbox. Treat oracle secrecy and host safety as cooperative experimental controls, not adversarial security boundaries."
    },
    tasks: taskSummaries.sort((left, right) => left.task_id.localeCompare(right.task_id)),
    trials: trials.sort((left, right) => left.task_id.localeCompare(right.task_id) || left.trial - right.trial),
    aggregate,
    ok: errors.length === 0,
    errors
  };
  if (options.output_path) writeBenchmarkReport(options.output_path, report);
  if (!preserveWorkspaces) fs.rmSync(runRoot, { recursive: true, force: true });
  return report;
}
