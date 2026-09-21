#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { CommandAgent, NoopAgent } from "./agent.js";
import { compareBenchmarkReportFiles } from "./comparison.js";
import { runBenchmarkSuite } from "./runner.js";
import { loadBenchmarkSuite, suiteUsesCommandChecks } from "./suite.js";
import { convertAuditJsonlToTrace } from "./trace.js";
import { benchmarkAgentProfileDescriptor, loadBenchmarkAgentProfile } from "./profile.js";
import { taskAvailability } from "./environment.js";
import type { BenchmarkAgent, BenchmarkRunOptions } from "./types.js";

const BOOLEAN_FLAGS = new Set(["noop", "allow-command-checks", "require-all", "preserve-workspaces", "fail-on-task-failure"]);

function usage(): string {
  return `Emacs Operator benchmark CLI

Commands:
  validate --suite FILE
  preflight --suite FILE [--require-all]
  profile-validate --profile FILE
  run --suite FILE --agent-id ID [--agent-version VERSION]
      [--agent-command-json JSON | --noop] --output FILE
      [--agent-profile FILE]
      [--trials N] [--seed N] [--work-root DIR] [--task ID]
      [--allow-command-checks] [--require-all] [--preserve-workspaces]
      [--fail-on-task-failure]
  compare --baseline FILE --candidate FILE --output FILE
  audit-to-trace --input FILE [--output FILE|-]
`;
}

function parse(argv: string[]): { command: string; values: Record<string, string | string[] | boolean> } {
  const command = argv[0] ?? "help";
  const values: Record<string, string | string[] | boolean> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) { values[key] = true; continue; }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new TypeError(`Missing value for --${key}.`);
    const existing = values[key];
    if (existing === undefined) values[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else values[key] = [String(existing), value];
  }
  return { command, values };
}
function one(values: Record<string, any>, key: string, required = false): string | undefined {
  const value = values[key];
  const output = Array.isArray(value) ? value[value.length - 1] : typeof value === "string" ? value : undefined;
  if (required && output === undefined) throw new TypeError(`--${key} is required.`);
  return output;
}
function many(values: Record<string, any>, key: string): string[] | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.map(String) : [String(value)];
}
function integer(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new TypeError(`${label} must be an integer.`);
  return number;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parse(argv);
  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") { process.stdout.write(usage()); return 0; }
  if (parsed.command === "profile-validate") {
    const loaded = loadBenchmarkAgentProfile(one(parsed.values, "profile", true)!);
    process.stdout.write(`${JSON.stringify({ id: loaded.profile.id, revision: loaded.profile.revision, kind: loaded.profile.kind, tool_profile: loaded.profile.tool_profile, digest: loaded.digest }, null, 2)}
`);
    return 0;
  }
  if (parsed.command === "validate") {
    const suite = loadBenchmarkSuite(one(parsed.values, "suite", true)!);
    const summary = {
      schema_version: suite.suite.schema_version,
      id: suite.suite.id,
      revision: suite.suite.revision,
      digest: suite.digest,
      tasks: suite.tasks.map(({ task, digest }) => ({ id: task.id, digest, checks: task.checks.length })),
      command_checks: suiteUsesCommandChecks(suite)
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  if (parsed.command === "preflight") {
    const suite = loadBenchmarkSuite(one(parsed.values, "suite", true)!);
    const tasks = suite.tasks.map(({ task }) => ({ id: task.id, ...taskAvailability(task) }));
    const available = tasks.filter((task) => task.available).length;
    const output = {
      schema_version: "1.0",
      suite: { id: suite.suite.id, revision: suite.suite.revision, digest: suite.digest },
      platform: process.platform,
      available_tasks: available,
      unavailable_tasks: tasks.length - available,
      tasks
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}
`);
    return parsed.values["require-all"] === true && available !== tasks.length ? 2 : 0;
  }
  if (parsed.command === "run") {
    const suitePath = one(parsed.values, "suite", true)!;
    const output = one(parsed.values, "output", true)!;
    const agentId = one(parsed.values, "agent-id", true)!;
    const agentVersion = one(parsed.values, "agent-version");
    const profileFile = one(parsed.values, "agent-profile");
    const loadedProfile = profileFile === undefined ? undefined : loadBenchmarkAgentProfile(profileFile);
    if (loadedProfile !== undefined && loadedProfile.profile.id !== agentId) throw new TypeError(`--agent-id ${agentId} does not match profile.id ${loadedProfile.profile.id}.`);
    const descriptorMetadata = loadedProfile === undefined ? undefined : { profile: benchmarkAgentProfileDescriptor(loadedProfile) };
    const noop = parsed.values.noop === true;
    const commandJson = one(parsed.values, "agent-command-json");
    if (noop === (commandJson !== undefined)) throw new TypeError("Choose exactly one of --noop or --agent-command-json.");
    let agent: BenchmarkAgent;
    if (noop) agent = new NoopAgent(agentId, agentVersion, descriptorMetadata);
    else {
      let command: unknown;
      try { command = JSON.parse(commandJson!); } catch { throw new TypeError("--agent-command-json must be valid JSON."); }
      if (!Array.isArray(command) || command.some((item) => typeof item !== "string")) throw new TypeError("--agent-command-json must be a JSON string array.");
      const loaded = loadBenchmarkSuite(suitePath);
      const maxOutputBytes = loaded.suite.defaults?.max_agent_output_bytes;
      agent = new CommandAgent({
        id: agentId,
        ...(agentVersion ? { version: agentVersion } : {}),
        command,
        ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
        ...(descriptorMetadata !== undefined ? { descriptorMetadata } : {})
      });
    }
    const parsedTrials = integer(one(parsed.values, "trials"), "--trials");
    const parsedSeed = integer(one(parsed.values, "seed"), "--seed");
    const workRoot = one(parsed.values, "work-root");
    const taskIds = many(parsed.values, "task");
    const runOptions: BenchmarkRunOptions = {
      ...(parsedTrials !== undefined ? { trials: parsedTrials } : {}),
      ...(parsedSeed !== undefined ? { seed: parsedSeed } : {}),
      ...(workRoot !== undefined ? { work_root: workRoot } : {}),
      allow_command_checks: parsed.values["allow-command-checks"] === true,
      require_all_tasks: parsed.values["require-all"] === true,
      preserve_workspaces: parsed.values["preserve-workspaces"] === true,
      ...(taskIds !== undefined ? { task_ids: taskIds } : {}),
      output_path: output
    };
    const report = await runBenchmarkSuite(suitePath, agent, runOptions);
    process.stdout.write(`${JSON.stringify({ run_id: report.run_id, output: path.resolve(output), ok: report.ok, aggregate: report.aggregate }, null, 2)}\n`);
    return parsed.values["fail-on-task-failure"] === true && report.aggregate.trials_failed > 0 ? 2 : report.ok ? 0 : 1;
  }
  if (parsed.command === "compare") {
    const output = one(parsed.values, "output", true)!;
    const report = compareBenchmarkReportFiles(one(parsed.values, "baseline", true)!, one(parsed.values, "candidate", true)!, output);
    process.stdout.write(`${JSON.stringify({ output: path.resolve(output), summary: report.summary, interpretation: report.interpretation }, null, 2)}\n`);
    return 0;
  }
  if (parsed.command === "audit-to-trace") {
    const events = convertAuditJsonlToTrace(one(parsed.values, "input", true)!);
    const text = events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
    const output = one(parsed.values, "output") ?? "-";
    if (output === "-") process.stdout.write(text);
    else {
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.resolve(output), text, { mode: 0o600 });
    }
    return 0;
  }
  throw new TypeError(`Unknown command: ${parsed.command}\n\n${usage()}`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
