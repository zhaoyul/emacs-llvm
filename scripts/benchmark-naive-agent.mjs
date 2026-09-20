#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

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
if (!directiveMatch) throw new Error("missing benchmark directive");
const directive = JSON.parse(directiveMatch[1]);
const target = path.resolve(request.workspace, directive.file);
event("agent_started");
event("tool_call", { tool: "filesystem.naive", operation: directive.operation, channel: "filesystem", mutation: true });
let content = fs.readFileSync(target, "utf8");
if (directive.operation === "rename_symbol") {
  let replacement = directive.new_symbol;
  if (directive.qualification_policy === "leaf_only") {
    const separator = directive.old_symbol.includes("::") ? "::" : directive.old_symbol.includes(":") ? ":" : directive.old_symbol.includes("/") ? "/" : "";
    if (separator) replacement = `${directive.old_symbol.slice(0, directive.old_symbol.lastIndexOf(separator))}${separator}${directive.new_symbol}`;
  }
  content = content.replaceAll(directive.old_symbol, replacement);
} else if (directive.operation === "insert_before") {
  content = `${content.replace(/\n*$/u, "\n")}${directive.text}\n`;
} else if (directive.operation === "org_author") {
  content = `${content.replace(/\n*$/u, "\n")}${directive.append_lines.filter((line) => !/^\|[-+]+\|$/u.test(line)).join("\n")}\n`;
}
fs.writeFileSync(target, content, "utf8");
event("agent_finished", { ok: true });
fs.mkdirSync(path.dirname(request.trace_path), { recursive: true });
fs.writeFileSync(request.trace_path, trace.map((item, index) => JSON.stringify({ sequence: index + 1, ...item })).join("\n") + "\n", "utf8");
process.stdout.write(`${JSON.stringify({ protocol_version: "1.0", status: "completed", summary: `Naive text agent completed ${request.task_id}.`, usage: { input_tokens: Math.ceil(request.prompt.length / 4), output_tokens: 20, tool_calls: 1, mutations: 1, rollbacks: 0 } })}\n`);
