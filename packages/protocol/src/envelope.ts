import { asOperatorError, type OperatorErrorShape } from "./errors.js";
import type { StateSummary } from "./types.js";

export interface ToolEnvelopeSuccess<T> {
  ok: true;
  request_id: string;
  session_id?: string;
  state_before?: StateSummary;
  state_after?: StateSummary;
  result: T;
  warnings: string[];
  audit_id: string;
}

export interface ToolEnvelopeFailure {
  ok: false;
  request_id: string;
  session_id?: string;
  error: OperatorErrorShape;
  warnings: string[];
  audit_id: string;
}

export type ToolEnvelope<T> = ToolEnvelopeSuccess<T> | ToolEnvelopeFailure;

export function successEnvelope<T>(args: {
  requestId: string;
  auditId: string;
  result: T;
  sessionId?: string;
  stateBefore?: StateSummary;
  stateAfter?: StateSummary;
  warnings?: string[];
}): ToolEnvelopeSuccess<T> {
  const out: ToolEnvelopeSuccess<T> = {
    ok: true,
    request_id: args.requestId,
    result: args.result,
    warnings: args.warnings ?? [],
    audit_id: args.auditId
  };
  if (args.sessionId !== undefined) out.session_id = args.sessionId;
  if (args.stateBefore !== undefined) out.state_before = args.stateBefore;
  if (args.stateAfter !== undefined) out.state_after = args.stateAfter;
  return out;
}

export function failureEnvelope(args: {
  requestId: string;
  auditId: string;
  error: unknown;
  sessionId?: string;
  warnings?: string[];
}): ToolEnvelopeFailure {
  const out: ToolEnvelopeFailure = {
    ok: false,
    request_id: args.requestId,
    error: asOperatorError(args.error).toJSON(),
    warnings: args.warnings ?? [],
    audit_id: args.auditId
  };
  if (args.sessionId !== undefined) out.session_id = args.sessionId;
  return out;
}
