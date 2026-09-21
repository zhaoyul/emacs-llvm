#!/usr/bin/env node
/*
 * Emacs Operator benchmark Agent protocol template.
 *
 * Copy this file into the wrapper that actually invokes your LLM/Agent. The
 * benchmark harness writes exactly one JSON request to stdin. Your wrapper may
 * edit only request.workspace, may write sanitized JSONL trace events to
 * request.trace_path, and must write exactly one JSON result to stdout. Send
 * human-readable logs to stderr.
 *
 * This template deliberately refuses the task. It demonstrates the protocol
 * without pretending to be an LLM implementation.
 */
import fs from "node:fs";
import path from "node:path";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.protocol_version !== "1.0") throw new TypeError("Unsupported benchmark protocol.");
if (!Number.isInteger(request.trial_seed)) throw new TypeError("Missing trial_seed.");

fs.mkdirSync(path.dirname(request.trace_path), { recursive: true, mode: 0o700 });
const events = [
  { sequence: 1, at_ms: 0, kind: "agent_started" },
  { sequence: 2, at_ms: 1, kind: "note", operation: "template_refusal", channel: "other", ok: true },
  { sequence: 3, at_ms: 2, kind: "agent_finished", ok: false }
];
fs.writeFileSync(request.trace_path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
process.stderr.write(`Benchmark template received ${request.task_id}, trial ${request.trial}, seed ${request.trial_seed}.\n`);
process.stdout.write(`${JSON.stringify({
  protocol_version: "1.0",
  status: "refused",
  summary: "Protocol template only. Replace this refusal with a real Agent invocation."
})}\n`);
