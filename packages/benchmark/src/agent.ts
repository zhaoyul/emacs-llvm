import childProcess from "node:child_process";
import path from "node:path";
import { canonicalJson, sha256Bytes } from "./hash.js";
import { sanitizeTraceEvents } from "./trace.js";
import type { BenchmarkAgent, BenchmarkAgentRequest, BenchmarkAgentResult, BenchmarkUsage } from "./types.js";

const { spawn } = childProcess;
const STATUSES = new Set(["completed", "failed", "refused", "timeout", "protocol_error"]);

function normalizedUsage(value: unknown): BenchmarkUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const output: BenchmarkUsage = {};
  for (const key of ["input_tokens", "output_tokens", "cached_input_tokens", "tool_calls", "mutations", "rollbacks"] as const) {
    const item = input[key];
    if (typeof item === "number" && Number.isFinite(item) && item >= 0) output[key] = Math.floor(item);
  }
  return Object.keys(output).length ? output : undefined;
}

export function normalizeAgentResult(value: unknown): BenchmarkAgentResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Agent result must be a JSON object.");
  const input = value as Record<string, unknown>;
  if (input.protocol_version !== "1.0") throw new TypeError("Agent result protocol_version must be 1.0.");
  if (typeof input.status !== "string" || !STATUSES.has(input.status)) throw new TypeError("Agent result has an unsupported status.");
  const summary = typeof input.summary === "string" ? input.summary.slice(0, 8192) : undefined;
  const usage = normalizedUsage(input.usage);
  const events = sanitizeTraceEvents(input.events);
  return {
    protocol_version: "1.0",
    status: input.status as BenchmarkAgentResult["status"],
    ...(summary !== undefined ? { summary } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(events.length ? { events } : {})
  };
}

export type InProcessAgentHandler = (request: BenchmarkAgentRequest, signal?: AbortSignal) => Promise<BenchmarkAgentResult> | BenchmarkAgentResult;

export class InProcessAgent implements BenchmarkAgent {
  readonly mode = "in_process";
  readonly version: string | undefined;
  constructor(readonly id: string, private readonly handler: InProcessAgentHandler, version?: string) { this.version = version; }
  async run(request: BenchmarkAgentRequest, signal?: AbortSignal): Promise<BenchmarkAgentResult> { return normalizeAgentResult(await this.handler(request, signal)); }
  descriptor(): Record<string, unknown> { return { mode: this.mode, handler: "in_process" }; }
}

export class NoopAgent implements BenchmarkAgent {
  readonly mode = "noop";
  readonly version: string | undefined;
  private readonly descriptorMetadata: Record<string, unknown> | undefined;
  constructor(readonly id = "noop", version?: string, descriptorMetadata?: Record<string, unknown>) {
    this.version = version;
    this.descriptorMetadata = descriptorMetadata === undefined ? undefined : structuredClone(descriptorMetadata);
  }
  async run(): Promise<BenchmarkAgentResult> { return { protocol_version: "1.0", status: "completed", summary: "No changes were made." }; }
  descriptor(): Record<string, unknown> { return { mode: this.mode, ...(this.descriptorMetadata ?? {}) }; }
}

export interface CommandAgentOptions {
  id: string;
  version?: string;
  command: string[];
  maxOutputBytes?: number;
  environment?: Record<string, string>;
  descriptorMetadata?: Record<string, unknown>;
}

export class CommandAgent implements BenchmarkAgent {
  readonly mode = "command_json_stdio";
  readonly id: string;
  readonly version: string | undefined;
  private readonly command: string[];
  private readonly maxOutputBytes: number;
  private readonly environment: Record<string, string>;
  private readonly descriptorMetadata: Record<string, unknown> | undefined;

  constructor(options: CommandAgentOptions) {
    if (!Array.isArray(options.command) || options.command.length === 0 || options.command.some((item) => typeof item !== "string" || item.length === 0)) throw new TypeError("CommandAgent command must be a non-empty string array.");
    this.id = options.id;
    this.version = options.version;
    this.command = [...options.command];
    this.maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    this.environment = { ...(options.environment ?? {}) };
    this.descriptorMetadata = options.descriptorMetadata === undefined ? undefined : structuredClone(options.descriptorMetadata);
  }

  descriptor(): Record<string, unknown> {
    return {
      mode: this.mode,
      executable: path.basename(this.command[0]),
      command_digest: sha256Bytes(canonicalJson(this.command)),
      arguments_redacted: Math.max(0, this.command.length - 1),
      ...(this.descriptorMetadata ?? {})
    };
  }

  async run(request: BenchmarkAgentRequest, signal?: AbortSignal): Promise<BenchmarkAgentResult> {
    return await new Promise((resolve, reject) => {
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      const child = spawn(this.command[0], this.command.slice(1), {
        cwd: request.workspace,
        env: {
          ...process.env,
          ...this.environment,
          EMACS_OPERATOR_BENCHMARK: "1",
          EMACS_OPERATOR_BENCHMARK_WORKSPACE: request.workspace,
          EMACS_OPERATOR_BENCHMARK_TASK_ID: request.task_id,
          EMACS_OPERATOR_BENCHMARK_TRIAL_SEED: String(request.trial_seed),
          EMACS_OPERATOR_BENCHMARK_TRACE: request.trace_path
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false
      });

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const abort = (): void => {
        child.kill("SIGTERM");
        globalThis.setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 250);
      };
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });

      child.on("error", (error: Error) => finish(() => reject(error)));
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > this.maxOutputBytes) { child.kill("SIGKILL"); finish(() => reject(new TypeError(`Agent stdout exceeds ${this.maxOutputBytes} bytes.`))); }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > this.maxOutputBytes) stderr = stderr.subarray(stderr.length - this.maxOutputBytes);
      });
      child.on("close", (code: number | null, closeSignal: string | null) => finish(() => {
        if (signal?.aborted) { resolve({ protocol_version: "1.0", status: "timeout", summary: "Agent process was aborted by the benchmark timeout." }); return; }
        if (code !== 0) { reject(new Error(`Agent command exited with ${code ?? closeSignal ?? "unknown"}. stderr: ${stderr.toString("utf8").slice(-2000)}`)); return; }
        const text = stdout.toString("utf8").trim();
        if (!text) { reject(new TypeError("Agent command produced no JSON result on stdout.")); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { reject(new TypeError("Agent stdout must contain exactly one JSON result. Write logs to stderr.")); return; }
        try { resolve(normalizeAgentResult(parsed)); }
        catch (error) { reject(error); }
      }));

      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }
}
