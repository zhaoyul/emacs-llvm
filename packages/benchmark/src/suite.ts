import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Bytes } from "./hash.js";
import { assertNoSymlinkPath, normalizeRelativePath, resolveInside } from "./pathSafety.js";
import type { BenchmarkCheck, BenchmarkSuite, BenchmarkTask, LoadedBenchmarkSuite, LoadedBenchmarkTask } from "./types.js";

const DOMAINS = new Set(["elisp", "clojure", "common_lisp", "org", "mixed"]);
const CATEGORIES = new Set(["repair", "refactor", "authoring", "navigation", "evaluation"]);
const DIFFICULTIES = new Set(["small", "medium", "large"]);
const CHECK_TYPES = new Set(["file_exists", "file_unchanged", "text_contains", "text_not_contains", "regex_count", "exact_text", "lisp_balance", "org_structure", "command"]);

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, any>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}
function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`${label} must be between ${minimum} and ${maximum}.`);
  return value;
}
function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const number = finite(value, label, minimum, maximum);
  if (!Number.isInteger(number)) throw new TypeError(`${label} must be an integer.`);
  return number;
}
function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new TypeError(`${label} must be an array of non-empty strings.`);
  return [...value];
}
function relative(value: unknown, label: string): string { return normalizeRelativePath(text(value, label), label); }

function validateCheck(raw: unknown, taskLabel: string, ids: Set<string>): BenchmarkCheck {
  const input = object(raw, `${taskLabel} check`);
  const id = text(input.id, `${taskLabel} check.id`);
  if (ids.has(id)) throw new TypeError(`${taskLabel} has duplicate check id: ${id}`);
  ids.add(id);
  const type = text(input.type, `${taskLabel} check.type`);
  if (!CHECK_TYPES.has(type)) throw new TypeError(`${taskLabel} check ${id} has unsupported type: ${type}`);
  const base: any = { id, type };
  if (input.weight !== undefined) base.weight = finite(input.weight, `${taskLabel} check ${id}.weight`, 0.000001, 1_000_000);
  if (input.required !== undefined) {
    if (typeof input.required !== "boolean") throw new TypeError(`${taskLabel} check ${id}.required must be boolean.`);
    base.required = input.required;
  }
  if (input.description !== undefined) base.description = text(input.description, `${taskLabel} check ${id}.description`).slice(0, 4096);

  if (type !== "command") base.path = relative(input.path, `${taskLabel} check ${id}.path`);
  if (type === "text_contains" || type === "text_not_contains") base.text = text(input.text, `${taskLabel} check ${id}.text`);
  if (type === "text_contains" && input.min_count !== undefined) base.min_count = optionalInteger(input.min_count, `${taskLabel} check ${id}.min_count`, 0, 1_000_000);
  if (type === "regex_count") {
    base.pattern = text(input.pattern, `${taskLabel} check ${id}.pattern`);
    try { new RegExp(base.pattern, typeof input.flags === "string" ? input.flags : "gu"); } catch (error) { throw new TypeError(`${taskLabel} check ${id} has invalid regex: ${String(error)}`); }
    if (input.flags !== undefined) base.flags = text(input.flags, `${taskLabel} check ${id}.flags`);
    if (input.min_count !== undefined) base.min_count = optionalInteger(input.min_count, `${taskLabel} check ${id}.min_count`, 0, 1_000_000);
    if (input.max_count !== undefined) base.max_count = optionalInteger(input.max_count, `${taskLabel} check ${id}.max_count`, 0, 1_000_000);
    if (base.min_count !== undefined && base.max_count !== undefined && base.min_count > base.max_count) throw new TypeError(`${taskLabel} check ${id} min_count exceeds max_count.`);
  }
  if (type === "exact_text") {
    if ((input.expected_text === undefined) === (input.expected_file === undefined)) throw new TypeError(`${taskLabel} check ${id} requires exactly one of expected_text or expected_file.`);
    if (input.expected_text !== undefined) base.expected_text = String(input.expected_text);
    if (input.expected_file !== undefined) base.expected_file = relative(input.expected_file, `${taskLabel} check ${id}.expected_file`);
    if (input.normalize_final_newline !== undefined) {
      if (typeof input.normalize_final_newline !== "boolean") throw new TypeError(`${taskLabel} check ${id}.normalize_final_newline must be boolean.`);
      base.normalize_final_newline = input.normalize_final_newline;
    }
  }
  if (type === "org_structure") {
    const expect = object(input.expect, `${taskLabel} check ${id}.expect`);
    const validated: any = {};
    for (const key of ["min_headings", "exact_headings", "min_tables", "exact_tables", "min_src_blocks", "exact_src_blocks"]) {
      if (expect[key] !== undefined) validated[key] = optionalInteger(expect[key], `${taskLabel} check ${id}.expect.${key}`, 0, 1_000_000);
    }
    for (const key of ["required_titles", "required_languages"]) if (expect[key] !== undefined) validated[key] = optionalStringArray(expect[key], `${taskLabel} check ${id}.expect.${key}`);
    if (expect.required_properties !== undefined) {
      const props = object(expect.required_properties, `${taskLabel} check ${id}.expect.required_properties`);
      validated.required_properties = {};
      for (const [key, value] of Object.entries(props)) validated.required_properties[text(key, "property key")] = String(value);
    }
    base.expect = validated;
  }
  if (type === "command") {
    if (!Array.isArray(input.command) || input.command.length === 0 || input.command.some((item: unknown) => typeof item !== "string" || item.length === 0)) throw new TypeError(`${taskLabel} check ${id}.command must be a non-empty string array.`);
    base.command = [...input.command];
    if (input.cwd !== undefined) base.cwd = relative(input.cwd, `${taskLabel} check ${id}.cwd`);
    if (input.timeout_ms !== undefined) base.timeout_ms = optionalInteger(input.timeout_ms, `${taskLabel} check ${id}.timeout_ms`, 1, 300_000);
    if (input.expected_exit_code !== undefined) base.expected_exit_code = optionalInteger(input.expected_exit_code, `${taskLabel} check ${id}.expected_exit_code`, 0, 255);
    if (input.stdout_contains !== undefined) base.stdout_contains = String(input.stdout_contains);
    if (input.stderr_contains !== undefined) base.stderr_contains = String(input.stderr_contains);
  }
  return base as BenchmarkCheck;
}

function validateTask(raw: unknown, ids: Set<string>): BenchmarkTask {
  const input = object(raw, "task");
  const id = text(input.id, "task.id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) throw new TypeError(`Invalid task id: ${id}`);
  if (ids.has(id)) throw new TypeError(`Duplicate task id: ${id}`);
  ids.add(id);
  const domain = text(input.domain, `task ${id}.domain`);
  const category = text(input.category, `task ${id}.category`);
  const difficulty = text(input.difficulty, `task ${id}.difficulty`);
  if (!DOMAINS.has(domain)) throw new TypeError(`task ${id} has unsupported domain: ${domain}`);
  if (!CATEGORIES.has(category)) throw new TypeError(`task ${id} has unsupported category: ${category}`);
  if (!DIFFICULTIES.has(difficulty)) throw new TypeError(`task ${id} has unsupported difficulty: ${difficulty}`);
  if (!Array.isArray(input.checks) || input.checks.length === 0) throw new TypeError(`task ${id}.checks must not be empty.`);
  const checkIds = new Set<string>();
  const task: any = {
    id,
    title: text(input.title, `task ${id}.title`),
    domain,
    category,
    difficulty,
    prompt_file: relative(input.prompt_file, `task ${id}.prompt_file`),
    fixture_dir: relative(input.fixture_dir, `task ${id}.fixture_dir`),
    checks: input.checks.map((check: unknown) => validateCheck(check, `task ${id}`, checkIds))
  };
  if (input.description !== undefined) task.description = text(input.description, `task ${id}.description`);
  if (input.tags !== undefined) task.tags = optionalStringArray(input.tags, `task ${id}.tags`);
  if (input.protected_paths !== undefined) task.protected_paths = optionalStringArray(input.protected_paths, `task ${id}.protected_paths`)?.map((item) => normalizeRelativePath(item, `task ${id}.protected_paths`));
  if (input.allowed_paths !== undefined) task.allowed_paths = optionalStringArray(input.allowed_paths, `task ${id}.allowed_paths`)?.map((item) => normalizeRelativePath(item, `task ${id}.allowed_paths`));
  if (input.pass_threshold !== undefined) task.pass_threshold = finite(input.pass_threshold, `task ${id}.pass_threshold`, 0, 1);
  if (input.timeout_ms !== undefined) task.timeout_ms = optionalInteger(input.timeout_ms, `task ${id}.timeout_ms`, 1, 3_600_000);
  if (input.requirements !== undefined) {
    const requirements = object(input.requirements, `task ${id}.requirements`);
    task.requirements = {};
    for (const key of ["executables", "platforms", "environment"]) if (requirements[key] !== undefined) task.requirements[key] = optionalStringArray(requirements[key], `task ${id}.requirements.${key}`);
  }
  return task as BenchmarkTask;
}

function collectTreeRecords(root: string): Array<{ path: string; bytes: number; sha256: string }> {
  const output: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a: any, b: any) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replaceAll(path.sep, "/");
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new TypeError(`Suite contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(full);
        output.push({ path: relative, bytes: stat.size, sha256: sha256Bytes(bytes) });
      } else throw new TypeError(`Suite contains a non-regular file: ${relative}`);
    }
  };
  visit(root);
  return output;
}

function verifierReferences(task: BenchmarkTask, suiteDir: string): Array<{ path: string; bytes: number; sha256: string }> {
  const references = new Set<string>();
  for (const check of task.checks) {
    if (check.type === "exact_text" && check.expected_file) references.add(check.expected_file);
    if (check.type === "command") {
      for (const argument of check.command) {
        const match = /^\$\{suite\}\/(.+)$/u.exec(argument);
        if (match) references.add(normalizeRelativePath(match[1]!, "command verifier path"));
      }
    }
  }
  const records: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const relative of [...references].sort()) {
    const full = resolveInside(suiteDir, relative, "referenced suite file");
    assertNoSymlinkPath(suiteDir, full, "referenced suite file");
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new TypeError(`Referenced suite file does not exist: ${relative}`);
    const bytes = fs.readFileSync(full);
    records.push({ path: relative, bytes: bytes.length, sha256: sha256Bytes(bytes) });
  }
  return records;
}

export function loadBenchmarkSuite(suitePath: string): LoadedBenchmarkSuite {
  const fullSuitePath = path.resolve(suitePath);
  if (!fs.existsSync(fullSuitePath) || !fs.statSync(fullSuitePath).isFile()) throw new TypeError(`Benchmark suite does not exist: ${fullSuitePath}`);
  const suiteDir = path.dirname(fullSuitePath);
  assertNoSymlinkPath(suiteDir, fullSuitePath, "suite path");
  const raw = JSON.parse(fs.readFileSync(fullSuitePath, "utf8"));
  const input = object(raw, "suite");
  if (input.schema_version !== "1.0") throw new TypeError("suite.schema_version must be 1.0.");
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new TypeError("suite.tasks must not be empty.");
  const ids = new Set<string>();
  const suite: any = {
    schema_version: "1.0",
    id: text(input.id, "suite.id"),
    revision: text(input.revision, "suite.revision"),
    title: text(input.title, "suite.title"),
    tasks: input.tasks.map((task: unknown) => validateTask(task, ids))
  };
  if (input.description !== undefined) suite.description = text(input.description, "suite.description");
  if (input.defaults !== undefined) {
    const defaults = object(input.defaults, "suite.defaults");
    suite.defaults = {};
    if (defaults.timeout_ms !== undefined) suite.defaults.timeout_ms = optionalInteger(defaults.timeout_ms, "suite.defaults.timeout_ms", 1, 3_600_000);
    if (defaults.trials !== undefined) suite.defaults.trials = optionalInteger(defaults.trials, "suite.defaults.trials", 1, 100);
    if (defaults.pass_threshold !== undefined) suite.defaults.pass_threshold = finite(defaults.pass_threshold, "suite.defaults.pass_threshold", 0, 1);
    if (defaults.max_workspace_bytes !== undefined) suite.defaults.max_workspace_bytes = optionalInteger(defaults.max_workspace_bytes, "suite.defaults.max_workspace_bytes", 1, 1024 * 1024 * 1024);
    if (defaults.max_agent_output_bytes !== undefined) suite.defaults.max_agent_output_bytes = optionalInteger(defaults.max_agent_output_bytes, "suite.defaults.max_agent_output_bytes", 1024, 64 * 1024 * 1024);
  }

  const loadedTasks: LoadedBenchmarkTask[] = [];
  for (const task of suite.tasks as BenchmarkTask[]) {
    const promptPath = resolveInside(suiteDir, task.prompt_file, `task ${task.id} prompt_file`);
    const fixturePath = resolveInside(suiteDir, task.fixture_dir, `task ${task.id} fixture_dir`);
    assertNoSymlinkPath(suiteDir, promptPath, `task ${task.id} prompt_file`);
    assertNoSymlinkPath(suiteDir, fixturePath, `task ${task.id} fixture_dir`);
    if (!fs.existsSync(promptPath) || !fs.statSync(promptPath).isFile()) throw new TypeError(`Task ${task.id} prompt_file does not exist.`);
    if (!fs.existsSync(fixturePath) || !fs.statSync(fixturePath).isDirectory()) throw new TypeError(`Task ${task.id} fixture_dir does not exist.`);
    const prompt = fs.readFileSync(promptPath, "utf8");
    const fixture = collectTreeRecords(fixturePath);
    const references = verifierReferences(task, suiteDir);
    const digest = sha256Bytes(canonicalJson({ task, prompt_sha256: sha256Bytes(prompt), fixture, references }));
    loadedTasks.push({ task, prompt, prompt_path: promptPath, fixture_path: fixturePath, digest });
  }
  const digest = sha256Bytes(canonicalJson({ suite, task_digests: loadedTasks.map((task) => ({ id: task.task.id, digest: task.digest })) }));
  return { suite: suite as BenchmarkSuite, suite_path: fullSuitePath, suite_dir: suiteDir, digest, tasks: loadedTasks };
}

export function suiteUsesCommandChecks(loaded: LoadedBenchmarkSuite): boolean {
  return loaded.tasks.some(({ task }) => task.checks.some((check) => check.type === "command"));
}
