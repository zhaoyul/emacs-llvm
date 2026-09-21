#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectRenamePlan, applyRenamePlanToFilesystem } from "../packages/refactor-intelligence/src/rename-plan.js";
import { checkLispBalance } from "../packages/refactor-intelligence/src/scanner.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = await new Promise((resolve, reject) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { text += chunk; });
  process.stdin.on("end", () => resolve(text));
  process.stdin.on("error", reject);
});
const request = JSON.parse(input);
const started = Date.now();
const trace = [];
const event = (kind, fields = {}) => trace.push({ at_ms: Date.now() - started, kind, ...fields });
const directiveMatch = /^BENCHMARK_DIRECTIVE:\s*(\{.*\})\s*$/mu.exec(request.prompt);
if (!directiveMatch) throw new Error(`task ${request.task_id} does not contain a benchmark directive`);
const directive = JSON.parse(directiveMatch[1]);
const target = path.resolve(request.workspace, directive.file);
if (target !== path.resolve(request.workspace) && !target.startsWith(`${path.resolve(request.workspace)}${path.sep}`)) throw new Error("directive escaped workspace");
event("agent_started");
event("tool_call", { tool: "semantic.reference", operation: directive.operation, channel: "semantic", mutation: true });

if (directive.operation === "rename_symbol") {
  const content = fs.readFileSync(target, "utf8");
  const plan = createProjectRenamePlan({
    root: path.resolve(request.workspace),
    files: [{ path: target, content }],
    oldSymbol: directive.old_symbol,
    newSymbol: directive.new_symbol,
    language: directive.language,
    qualificationPolicy: directive.qualification_policy
  });
  await applyRenamePlanToFilesystem(plan);
} else if (directive.operation === "insert_before") {
  const content = fs.readFileSync(target, "utf8");
  const occurrence = content.indexOf(directive.marker);
  if (occurrence < 0 || content.indexOf(directive.marker, occurrence + 1) >= 0) throw new Error("insert marker must occur exactly once");
  fs.writeFileSync(target, `${content.slice(0, occurrence)}${directive.text}${content.slice(occurrence)}`, "utf8");
  const balance = checkLispBalance(fs.readFileSync(target, "utf8"));
  event("validation", { tool: "lisp.balance", ok: balance.balanced, channel: "semantic" });
  if (!balance.balanced) throw new Error("reference repair did not balance Lisp source");
} else if (directive.operation === "org_author") {
  const original = fs.readFileSync(target, "utf8").replace(/\n*$/u, "\n");
  fs.writeFileSync(target, `${original}${directive.append_lines.join("\n")}\n`, "utf8");
  event("validation", { tool: "org.structure", ok: true, channel: "semantic" });
} else throw new Error(`unsupported reference directive: ${directive.operation}`);

event("agent_finished", { ok: true });
fs.mkdirSync(path.dirname(request.trace_path), { recursive: true });
fs.writeFileSync(request.trace_path, trace.map((item, index) => JSON.stringify({ sequence: index + 1, ...item })).join("\n") + "\n", "utf8");
process.stdout.write(`${JSON.stringify({
  protocol_version: "1.0",
  status: "completed",
  summary: `Deterministic semantic reference completed ${request.task_id}.`,
  usage: { input_tokens: Math.ceil(request.prompt.length / 4), output_tokens: 32, tool_calls: 1, mutations: 1, rollbacks: 0 }
})}\n`);
