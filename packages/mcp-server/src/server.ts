#!/usr/bin/env node
import { McpWireServer } from "./mcpWireServer.js";

const server = new McpWireServer();
let pending = "";
let queue: Promise<void> = Promise.resolve();

process.stdout.on("error", (error: any) => {
  if (error?.code === "EPIPE") process.exit(0);
  throw error;
});

async function processLine(line: string): Promise<void> {
  let request: any;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
    return;
  }
  const response = await server.handle(request);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  pending += chunk;
  while (true) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (!line) continue;
    queue = queue.then(() => processLine(line));
  }
});

process.stdin.on("end", () => {
  queue.finally(() => server.router.bridges.closeAll());
});
