#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const entry = process.argv[2];
const expectedVersion = process.argv[3];
if (!entry || !expectedVersion) {
  process.stderr.write("Usage: smoke-mcp-server.mjs <server.js> <expected-version>\n");
  process.exit(64);
}

const child = spawn(process.execPath, [path.resolve(entry)], {
  cwd: path.dirname(path.resolve(entry)),
  stdio: ["pipe", "pipe", "pipe"]
});
let stdout = "";
let stderr = "";
let settled = false;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

function finish(code, value) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (child.exitCode === null) child.kill(code === 0 ? "SIGTERM" : "SIGKILL");
  if (value !== undefined) {
    const stream = code === 0 ? process.stdout : process.stderr;
    stream.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
  }
  process.exitCode = code;
}

const timer = setTimeout(() => finish(1, `MCP server smoke timed out. stderr=${stderr.slice(-2000)}`), 8000);
child.once("error", (error) => finish(1, error.stack ?? error.message));
child.once("exit", (code) => {
  if (!settled && code !== 0) finish(1, `MCP server exited early with ${String(code)}. stderr=${stderr.slice(-2000)}`);
});
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2 || settled) return;
  try {
    const messages = lines.map((line) => JSON.parse(line));
    const init = messages.find((message) => message.id === 1);
    const health = messages.find((message) => message.id === 2);
    if (init?.result?.serverInfo?.version !== expectedVersion) {
      throw new Error(`initialize version mismatch: ${JSON.stringify(init)}`);
    }
    const healthText = health?.result?.content?.[0]?.text;
    if (typeof healthText !== "string") throw new Error(`health content is malformed: ${JSON.stringify(health)}`);
    const envelope = JSON.parse(healthText);
    if (envelope?.ok !== true || envelope?.result?.status !== "ok" || envelope?.result?.version !== expectedVersion) {
      throw new Error(`health envelope mismatch: ${healthText}`);
    }
    finish(0, { ok: true, serverInfo: init.result.serverInfo, health: envelope.result });
  } catch (error) {
    finish(1, error instanceof Error ? error.stack ?? error.message : String(error));
  }
});

for (const request of [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-smoke", version: "1" } } },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "emacs_health", arguments: {} } }
]) child.stdin.write(`${JSON.stringify(request)}\n`);
