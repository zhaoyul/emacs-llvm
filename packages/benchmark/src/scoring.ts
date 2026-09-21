import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Bytes } from "./hash.js";
import { resolveInside } from "./pathSafety.js";
import { checkLispBalance, parseOrgStructure } from "./structure.js";
import type { BenchmarkAgentResult, BenchmarkCheck, BenchmarkCheckResult, BenchmarkScore, LoadedBenchmarkTask, WorkspaceSnapshot } from "./types.js";

const { spawnSync } = childProcess;
const BENCHMARK_PRIVATE_DIRECTORY = ".emacs-operator-benchmark";

export interface ScoreContext {
  workspace: string;
  suite_dir: string;
  before: WorkspaceSnapshot;
  after: WorkspaceSnapshot;
  protected_path_violations: string[];
  unauthorized_path_violations: string[];
  agent_result: BenchmarkAgentResult;
  allow_command_checks: boolean;
}

function countLiteral(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const found = text.indexOf(needle, cursor);
    if (found < 0) return count;
    count += 1;
    cursor = found + needle.length;
  }
}

function normalizeFinalNewline(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(/\n*$/u, "\n");
}

function base(check: BenchmarkCheck, started: number): Omit<BenchmarkCheckResult, "status"> {
  return {
    id: check.id,
    type: check.type,
    required: check.required !== false,
    weight: check.weight ?? 1,
    ...(check.description !== undefined ? { description: check.description } : {}),
    duration_ms: Date.now() - started
  };
}

function result(check: BenchmarkCheck, started: number, status: BenchmarkCheckResult["status"], details?: Record<string, unknown>): BenchmarkCheckResult {
  return { ...base(check, started), status, ...(details ? { details } : {}) };
}

function readText(workspace: string, relative: string): { full: string; text: string; bytes: number; sha256: string } {
  const full = resolveInside(workspace, relative, "check path");
  if (!fs.existsSync(full) || !fs.lstatSync(full).isFile() || fs.lstatSync(full).isSymbolicLink()) throw new TypeError(`Expected regular file is missing: ${relative}`);
  const bytes = fs.readFileSync(full);
  return { full, text: bytes.toString("utf8"), bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

function expandCommand(command: string[], context: ScoreContext, taskId: string): string[] {
  const replacements: Record<string, string> = {
    workspace: context.workspace,
    suite: context.suite_dir,
    task: taskId
  };
  return command.map((part) => part.replace(/\$\{(workspace|suite|task)\}/gu, (_match, key) => replacements[key]!));
}

function copyVerificationWorkspace(source: string, destination: string, expectedBytes: number): void {
  const byteLimit = Math.max(1024 * 1024, expectedBytes + 1024 * 1024);
  let copiedBytes = 0;
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const visit = (from: string, to: string, relativeDirectory = ""): void => {
    const entries = fs.readdirSync(from, { withFileTypes: true }).sort((left: any, right: any) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relative === BENCHMARK_PRIVATE_DIRECTORY || relative.startsWith(`${BENCHMARK_PRIVATE_DIRECTORY}/`)) continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      const stat = fs.lstatSync(src);
      if (stat.isSymbolicLink()) throw new TypeError(`Verification workspace contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true, mode: stat.mode & 0o777 });
        visit(src, dst, relative);
      } else if (entry.isFile()) {
        copiedBytes += stat.size;
        if (copiedBytes > byteLimit) throw new TypeError("Workspace changed while preparing the isolated verifier copy.");
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(dst, stat.mode & 0o777);
      } else {
        throw new TypeError(`Verification workspace contains a non-regular file: ${relative}`);
      }
    }
  };
  visit(source, destination);
}

function evaluateOrgExpectation(structure: ReturnType<typeof parseOrgStructure>, expect: any): string[] {
  const failures: string[] = [];
  if (expect.min_headings !== undefined && structure.headings.length < expect.min_headings) failures.push(`headings ${structure.headings.length} < ${expect.min_headings}`);
  if (expect.exact_headings !== undefined && structure.headings.length !== expect.exact_headings) failures.push(`headings ${structure.headings.length} != ${expect.exact_headings}`);
  if (expect.min_tables !== undefined && structure.tables < expect.min_tables) failures.push(`tables ${structure.tables} < ${expect.min_tables}`);
  if (expect.exact_tables !== undefined && structure.tables !== expect.exact_tables) failures.push(`tables ${structure.tables} != ${expect.exact_tables}`);
  if (expect.min_src_blocks !== undefined && structure.src_blocks < expect.min_src_blocks) failures.push(`src_blocks ${structure.src_blocks} < ${expect.min_src_blocks}`);
  if (expect.exact_src_blocks !== undefined && structure.src_blocks !== expect.exact_src_blocks) failures.push(`src_blocks ${structure.src_blocks} != ${expect.exact_src_blocks}`);
  const actualTitles = structure.headings.map((heading) => heading.title);
  for (const title of expect.required_titles ?? []) if (!actualTitles.includes(title)) failures.push(`missing title: ${title}`);
  for (const language of expect.required_languages ?? []) if (!structure.source_languages.includes(language.toLowerCase())) failures.push(`missing language: ${language}`);
  for (const [key, expected] of Object.entries(expect.required_properties ?? {})) {
    if (!(structure.properties[key.toUpperCase()] ?? []).includes(String(expected))) failures.push(`missing property ${key}=${expected}`);
  }
  for (const diagnostic of structure.diagnostics) failures.push(`${diagnostic.code} at line ${diagnostic.line}`);
  return failures;
}

export function evaluateBenchmarkCheck(check: BenchmarkCheck, loadedTask: LoadedBenchmarkTask, context: ScoreContext): BenchmarkCheckResult {
  const started = Date.now();
  try {
    if (check.type === "command") {
      if (!context.allow_command_checks) return result(check, started, "skipped", { reason: "command checks are disabled" });
      const verificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-verifier-"));
      const verificationWorkspace = path.join(verificationRoot, "workspace");
      try {
        copyVerificationWorkspace(context.workspace, verificationWorkspace, context.after.total_bytes);
        const verificationContext = { ...context, workspace: verificationWorkspace };
        const expanded = expandCommand(check.command, verificationContext, loadedTask.task.id);
        const cwd = check.cwd ? resolveInside(verificationWorkspace, check.cwd, `check ${check.id} cwd`) : verificationWorkspace;
        const execution = spawnSync(expanded[0], expanded.slice(1), {
          cwd,
          encoding: "utf8",
          shell: false,
          timeout: check.timeout_ms ?? 30_000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            CI: "1",
            EMACS_OPERATOR_BENCHMARK: "1",
            EMACS_OPERATOR_BENCHMARK_WORKSPACE: verificationWorkspace,
            EMACS_OPERATOR_BENCHMARK_SUITE: context.suite_dir,
            EMACS_OPERATOR_BENCHMARK_TASK: loadedTask.task.id,
            EMACS_OPERATOR_BENCHMARK_VERIFIER_COPY: "1"
          }
        });
        const exitCode = execution.status ?? (execution.signal ? 128 : 125);
        const expectedExitCode = check.expected_exit_code ?? 0;
        const stdout = String(execution.stdout ?? "");
        const stderr = String(execution.stderr ?? "");
        const passed = exitCode === expectedExitCode &&
          (check.stdout_contains === undefined || stdout.includes(check.stdout_contains)) &&
          (check.stderr_contains === undefined || stderr.includes(check.stderr_contains));
        return result(check, started, passed ? "pass" : "fail", {
          executable: path.basename(expanded[0]),
          exit_code: exitCode,
          expected_exit_code: expectedExitCode,
          signal: execution.signal ?? null,
          verifier_workspace: "isolated_copy",
          stdout_tail: stdout.slice(-2000),
          stderr_tail: stderr.slice(-2000),
          ...(execution.error ? { error: String(execution.error.message ?? execution.error) } : {})
        });
      } finally {
        fs.rmSync(verificationRoot, { recursive: true, force: true });
      }
    }

    if (check.type === "file_exists") {
      const full = resolveInside(context.workspace, check.path, `check ${check.id} path`);
      const passed = fs.existsSync(full) && fs.lstatSync(full).isFile() && !fs.lstatSync(full).isSymbolicLink();
      return result(check, started, passed ? "pass" : "fail", { path: check.path });
    }

    if (check.type === "file_unchanged") {
      const before = context.before.files.find((file) => file.path === check.path);
      const after = context.after.files.find((file) => file.path === check.path);
      const passed = !!before && !!after && before.sha256 === after.sha256 && before.mode === after.mode;
      return result(check, started, passed ? "pass" : "fail", {
        path: check.path,
        before_sha256: before?.sha256 ?? null,
        after_sha256: after?.sha256 ?? null
      });
    }

    const actual = readText(context.workspace, check.path);
    if (check.type === "text_contains") {
      const count = countLiteral(actual.text, check.text);
      const minimum = check.min_count ?? 1;
      return result(check, started, count >= minimum ? "pass" : "fail", { path: check.path, count, minimum });
    }
    if (check.type === "text_not_contains") {
      const count = countLiteral(actual.text, check.text);
      return result(check, started, count === 0 ? "pass" : "fail", { path: check.path, count });
    }
    if (check.type === "regex_count") {
      const flags = check.flags ?? "gu";
      const regex = new RegExp(check.pattern, flags.includes("g") ? flags : `${flags}g`);
      const count = [...actual.text.matchAll(regex)].length;
      const minimum = check.min_count ?? 0;
      const maximum = check.max_count ?? Number.POSITIVE_INFINITY;
      return result(check, started, count >= minimum && count <= maximum ? "pass" : "fail", { path: check.path, count, minimum, maximum: Number.isFinite(maximum) ? maximum : null });
    }
    if (check.type === "exact_text") {
      const expected = check.expected_text !== undefined
        ? check.expected_text
        : fs.readFileSync(resolveInside(context.suite_dir, check.expected_file!, `check ${check.id} expected_file`), "utf8");
      const normalize = check.normalize_final_newline !== false;
      const left = normalize ? normalizeFinalNewline(actual.text) : actual.text;
      const right = normalize ? normalizeFinalNewline(expected) : expected;
      return result(check, started, left === right ? "pass" : "fail", {
        path: check.path,
        actual_sha256: actual.sha256,
        expected_sha256: sha256Bytes(Buffer.from(expected, "utf8")),
        actual_bytes: actual.bytes,
        expected_bytes: Buffer.byteLength(expected, "utf8")
      });
    }
    if (check.type === "lisp_balance") {
      const balance = checkLispBalance(actual.text);
      return result(check, started, balance.balanced ? "pass" : "fail", { path: check.path, diagnostics: balance.diagnostics.slice(0, 50) });
    }
    if (check.type === "org_structure") {
      const structure = parseOrgStructure(actual.text);
      const failures = evaluateOrgExpectation(structure, check.expect);
      return result(check, started, failures.length === 0 ? "pass" : "fail", {
        path: check.path,
        failures,
        counts: { headings: structure.headings.length, tables: structure.tables, src_blocks: structure.src_blocks },
        titles: structure.headings.map((heading) => heading.title).slice(0, 100),
        languages: structure.source_languages
      });
    }
    return result(check, started, "error", { error: `Unsupported check type: ${(check as any).type}` });
  } catch (error) {
    return result(check, started, "error", { error: error instanceof Error ? error.message : String(error) });
  }
}

export function scoreTask(loadedTask: LoadedBenchmarkTask, context: ScoreContext, threshold: number): BenchmarkScore {
  const checks = loadedTask.task.checks.map((check) => evaluateBenchmarkCheck(check, loadedTask, context));
  const scored = checks.filter((check) => check.status !== "skipped");
  const totalWeight = scored.reduce((sum, check) => sum + check.weight, 0);
  const passedWeight = scored.filter((check) => check.status === "pass").reduce((sum, check) => sum + check.weight, 0);
  const score = totalWeight > 0 ? passedWeight / totalWeight : 0;
  const requiredChecksPassed = checks.filter((check) => check.required).every((check) => check.status === "pass");
  const agentCompleted = context.agent_result.status === "completed";
  const protectedPathsClean = context.protected_path_violations.length === 0;
  const allowedPathsClean = context.unauthorized_path_violations.length === 0;
  return {
    score,
    threshold,
    passed_weight: passedWeight,
    total_weight: totalWeight,
    required_checks_passed: requiredChecksPassed,
    agent_completed: agentCompleted,
    protected_paths_clean: protectedPathsClean,
    allowed_paths_clean: allowedPathsClean,
    passed: agentCompleted && protectedPathsClean && allowedPathsClean && requiredChecksPassed && score >= threshold,
    checks
  };
}
