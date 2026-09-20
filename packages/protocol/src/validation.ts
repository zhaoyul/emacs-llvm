import { OperatorError } from "./errors.js";
import type { MutationPrecondition } from "./types.js";

export function assertObject(value: unknown, name = "value"): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorError("E_SCHEMA_VALIDATION", `${name} must be an object.`);
  }
}

export function requiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new OperatorError("E_SCHEMA_VALIDATION", `${key} must be a non-empty string.`);
  }
  return value;
}

export function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new OperatorError("E_SCHEMA_VALIDATION", `${key} must be a string.`);
  return value;
}

export function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new OperatorError("E_SCHEMA_VALIDATION", `${key} must be a number.`);
  return value;
}

export function validatePrecondition(value: unknown): MutationPrecondition | undefined {
  if (value === undefined) return undefined;
  assertObject(value, "precondition");
  const out: MutationPrecondition = {};
  const stateSeq = optionalNumber(value, "expected_state_seq");
  const tick = optionalNumber(value, "expected_buffer_tick");
  const pid = optionalNumber(value, "expected_frontmost_pid");
  const bufferId = optionalString(value, "expected_buffer_id");
  const mode = optionalString(value, "expected_major_mode");
  if (stateSeq !== undefined) out.expected_state_seq = stateSeq;
  if (tick !== undefined) out.expected_buffer_tick = tick;
  if (pid !== undefined) out.expected_frontmost_pid = pid;
  if (bufferId !== undefined) out.expected_buffer_id = bufferId;
  if (mode !== undefined) out.expected_major_mode = mode;
  return out;
}
