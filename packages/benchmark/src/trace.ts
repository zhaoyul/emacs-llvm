import fs from "node:fs";
import type { BenchmarkProcessMetrics, BenchmarkTraceEvent } from "./types.js";

const KINDS = new Set(["agent_started", "agent_finished", "tool_call", "tool_result", "validation", "evaluation", "rollback", "note"]);
const CHANNELS = new Set(["semantic", "internal_keys", "native_keys", "filesystem", "other"]);
const MAX_EVENTS = 10_000;
const MAX_TRACE_BYTES = 2 * 1024 * 1024;

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function sanitizeTraceEvents(value: unknown): BenchmarkTraceEvent[] {
  if (!Array.isArray(value)) return [];
  const output: BenchmarkTraceEvent[] = [];
  for (const raw of value.slice(0, MAX_EVENTS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const input = raw as Record<string, unknown>;
    if (typeof input.kind !== "string" || !KINDS.has(input.kind)) continue;
    const at = finiteNonNegative(input.at_ms);
    if (at === undefined) continue;
    const event: BenchmarkTraceEvent = { at_ms: at, kind: input.kind as BenchmarkTraceEvent["kind"] };
    if (typeof input.sequence === "number" && Number.isInteger(input.sequence) && input.sequence >= 0) event.sequence = input.sequence;
    if (typeof input.tool === "string") event.tool = input.tool.slice(0, 256);
    if (typeof input.operation === "string") event.operation = input.operation.slice(0, 256);
    if (typeof input.channel === "string" && CHANNELS.has(input.channel)) event.channel = input.channel as NonNullable<BenchmarkTraceEvent["channel"]>;
    if (typeof input.mutation === "boolean") event.mutation = input.mutation;
    if (typeof input.ok === "boolean") event.ok = input.ok;
    for (const key of ["duration_ms", "input_tokens", "output_tokens"] as const) {
      const item = finiteNonNegative(input[key]);
      if (item !== undefined) event[key] = Math.floor(item);
    }
    if (typeof input.error_code === "string") event.error_code = input.error_code.slice(0, 128);
    output.push(event);
  }
  return output;
}

export function readTraceFile(file: string): BenchmarkTraceEvent[] {
  if (!fs.existsSync(file)) return [];
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("Trace path must be a regular file.");
  if (stat.size > MAX_TRACE_BYTES) throw new TypeError(`Trace file exceeds ${MAX_TRACE_BYTES} bytes.`);
  const events: unknown[] = [];
  for (const [index, line] of fs.readFileSync(file, "utf8").split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); }
    catch { throw new TypeError(`Trace line ${index + 1} is not valid JSON.`); }
  }
  return sanitizeTraceEvents(events);
}

export function summarizeTrace(events: BenchmarkTraceEvent[], usage?: { input_tokens?: number; output_tokens?: number }): Omit<BenchmarkProcessMetrics, "duration_ms"> {
  const toolCalls = events.filter((event) => event.kind === "tool_call").length;
  const mutations = events.filter((event) => event.mutation === true).length;
  const rollbacks = events.filter((event) => event.kind === "rollback").length;
  const toolErrors = events.filter((event) => (event.kind === "tool_result" || event.kind === "evaluation" || event.kind === "validation") && event.ok === false).length;
  const validations = events.filter((event) => event.kind === "validation").length;
  const evaluations = events.filter((event) => event.kind === "evaluation").length;
  const traceInput = events.reduce((sum, event) => sum + (event.input_tokens ?? 0), 0);
  const traceOutput = events.reduce((sum, event) => sum + (event.output_tokens ?? 0), 0);
  return {
    tool_calls: toolCalls,
    mutations,
    rollbacks,
    tool_errors: toolErrors,
    validations,
    evaluations,
    input_tokens: usage?.input_tokens ?? (traceInput > 0 ? traceInput : null),
    output_tokens: usage?.output_tokens ?? (traceOutput > 0 ? traceOutput : null)
  };
}

export function convertAuditJsonlToTrace(inputFile: string): BenchmarkTraceEvent[] {
  const events: BenchmarkTraceEvent[] = [];
  if (!fs.existsSync(inputFile)) return events;
  for (const [index, line] of fs.readFileSync(inputFile, "utf8").split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let value: any;
    try { value = JSON.parse(line); } catch { continue; }
    const tool = typeof value.tool === "string" ? value.tool : typeof value.method === "string" ? value.method : undefined;
    const operation = typeof value.operation === "string" ? value.operation : undefined;
    const ok = typeof value.ok === "boolean" ? value.ok : typeof value.success === "boolean" ? value.success : undefined;
    const atRaw = value.at_ms ?? value.timestamp_ms ?? value.time_ms ?? index;
    const at = typeof atRaw === "number" && Number.isFinite(atRaw) ? Math.max(0, atRaw) : index;
    events.push({ sequence: index, at_ms: at, kind: "tool_call", ...(tool ? { tool } : {}), ...(operation ? { operation } : {}), ...(typeof value.mutation === "boolean" ? { mutation: value.mutation } : {}) });
    events.push({ sequence: index * 2 + 1, at_ms: at, kind: tool === "emacs_rollback" ? "rollback" : "tool_result", ...(tool ? { tool } : {}), ...(operation ? { operation } : {}), ...(ok !== undefined ? { ok } : {}), ...(typeof value.error_code === "string" ? { error_code: value.error_code } : {}) });
  }
  return sanitizeTraceEvents(events);
}
