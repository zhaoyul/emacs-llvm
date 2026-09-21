import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CommandAgent, normalizeAgentResult } from "../src/agent.js";
import { temporaryDirectory } from "./helpers.js";

function request(workspace: string) {
  return { protocol_version: "1.0" as const, run_id: "run", suite_id: "suite", suite_revision: "1", suite_digest: "a", task_id: "task", task_digest: "b", trial: 1, trial_seed: 123, prompt: "work", workspace, timeout_ms: 1000, trace_path: path.join(workspace, ".emacs-operator-benchmark", "trace.jsonl"), metadata: { domain: "mixed" as const, category: "repair" as const, difficulty: "small" as const, tags: [] } };
}

test("agent result normalization bounds summaries and events", () => {
  const result = normalizeAgentResult({ protocol_version: "1.0", status: "completed", summary: "x".repeat(9000), usage: { input_tokens: 4.9, bad: 1 }, events: [{ at_ms: 1, kind: "note", tool: "x" }] });
  assert.equal(result.summary?.length, 8192);
  assert.equal(result.usage?.input_tokens, 4);
  assert.equal(result.events?.length, 1);
});

test("CommandAgent exchanges exactly one JSON object over stdio", async () => {
  const root = temporaryDirectory();
  try {
    fs.mkdirSync(path.join(root, ".emacs-operator-benchmark"));
    const script = path.join(root, "agent.mjs");
    fs.writeFileSync(script, `let text=""; for await (const chunk of process.stdin) text += chunk; const request=JSON.parse(text); process.stderr.write("log\\n"); process.stdout.write(JSON.stringify({protocol_version:"1.0",status:"completed",summary:request.task_id}));`);
    const agent = new CommandAgent({ id: "command", command: [process.execPath, script] });
    const result = await agent.run(request(root));
    assert.equal(result.status, "completed");
    assert.equal(result.summary, "task");
    const descriptor = agent.descriptor();
    assert.equal(descriptor.executable, path.basename(process.execPath));
    assert.equal("command" in descriptor, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CommandAgent rejects stdout logging before JSON", async () => {
  const root = temporaryDirectory();
  try {
    fs.mkdirSync(path.join(root, ".emacs-operator-benchmark"));
    const script = path.join(root, "bad.mjs");
    fs.writeFileSync(script, `process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("log\\n"+JSON.stringify({protocol_version:"1.0",status:"completed"})));`);
    const agent = new CommandAgent({ id: "bad", command: [process.execPath, script] });
    await assert.rejects(agent.run(request(root)), /exactly one JSON result/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CommandAgent responds to abort", async () => {
  const root = temporaryDirectory();
  try {
    fs.mkdirSync(path.join(root, ".emacs-operator-benchmark"));
    const script = path.join(root, "slow.mjs");
    fs.writeFileSync(script, `process.stdin.resume(); setTimeout(()=>process.stdout.write(JSON.stringify({protocol_version:"1.0",status:"completed"})),5000);`);
    const agent = new CommandAgent({ id: "slow", command: [process.execPath, script] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const result = await agent.run(request(root), controller.signal);
    assert.equal(result.status, "timeout");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
