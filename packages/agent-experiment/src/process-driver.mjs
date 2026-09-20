import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_EVENTS, DEFAULT_MAX_STDERR_BYTES, DEFAULT_MAX_STDOUT_BYTES } from "./constants.mjs";
import { AgentExperimentError, errorToObject, invariant } from "./errors.mjs";
import { parseDriverJsonLines, validateDriverRequest } from "./protocol.mjs";
import { truncateText } from "./redaction.mjs";
import { sha256 } from "./canonical.mjs";
async function terminateProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  try { process.platform === "win32" ? child.kill("SIGTERM") : process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (child.exitCode === null) {
    try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}
export async function invokeProcessDriver({ request, command, args = [], env, trace, maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES, maxStderrBytes = DEFAULT_MAX_STDERR_BYTES, maxEvents = DEFAULT_MAX_EVENTS }) {
  validateDriverRequest(request);
  invariant(typeof command === "string" && command.length > 0, "E_DRIVER_COMMAND", "Driver command is required");
  invariant(Array.isArray(args) && args.every((item) => typeof item === "string"), "E_DRIVER_ARGS", "Driver args must be an array of strings");
  invariant(fs.existsSync(request.workspace) && fs.statSync(request.workspace).isDirectory(), "E_WORKSPACE", "Driver workspace does not exist");
  trace?.write("driver.spawn", { command: path.basename(command), args_count: args.length, workspace: request.workspace, request_id: request.request_id });
  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: request.workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true
  });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), overflow;
  child.stdout.on("data", (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.length > maxStdoutBytes && !overflow) { overflow = "stdout"; void terminateProcess(child); }
  });
  child.stderr.on("data", (chunk) => {
    stderr = Buffer.concat([stderr, chunk]);
    if (stderr.length > maxStderrBytes && !overflow) { overflow = "stderr"; void terminateProcess(child); }
  });
  child.stdin.end(`${JSON.stringify(request)}
`);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void terminateProcess(child); }, request.timeout_ms);
  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const durationMs = Date.now() - startedAt;
  const stdoutInfo = truncateText(stdout.toString("utf8"), maxStdoutBytes);
  const stderrInfo = truncateText(stderr.toString("utf8"), maxStderrBytes);
  trace?.write("driver.exit", {
    request_id: request.request_id, code: exit.code, signal: exit.signal, duration_ms: durationMs,
    stdout_bytes: stdout.length, stderr_bytes: stderr.length, stdout_sha256: sha256(stdout), stderr_sha256: sha256(stderr),
    timed_out: timedOut, overflow: overflow ?? null
  });
  if (timedOut) throw new AgentExperimentError("E_DRIVER_TIMEOUT", `Driver exceeded ${request.timeout_ms} ms`, { duration_ms: durationMs });
  if (overflow) throw new AgentExperimentError("E_DRIVER_OUTPUT_LIMIT", `Driver exceeded ${overflow} limit`, { stream: overflow });
  if (exit.code !== 0) throw new AgentExperimentError("E_DRIVER_EXIT", `Driver exited with code ${exit.code}`, { code: exit.code, signal: exit.signal, stderr: stderrInfo.text });
  const parsed = parseDriverJsonLines(stdoutInfo.text, request.request_id, maxEvents);
  for (const event of parsed.events) trace?.write("agent.event", { request_id: request.request_id, event });
  trace?.write("agent.result", { request_id: request.request_id, result: parsed.result });
  return {
    result: parsed.result,
    events: parsed.events,
    process: {
      exit_code: exit.code, signal: exit.signal, duration_ms: durationMs,
      stdout_bytes: stdout.length, stderr_bytes: stderr.length,
      stdout_sha256: sha256(stdout), stderr_sha256: sha256(stderr),
      stderr: stderrInfo.text, stderr_truncated: stderrInfo.truncated
    }
  };
}
export async function safeInvokeProcessDriver(options) {
  try { return { ok: true, value: await invokeProcessDriver(options) }; }
  catch (error) { return { ok: false, error: errorToObject(error) }; }
}
