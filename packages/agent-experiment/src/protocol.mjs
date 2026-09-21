import path from "node:path";
import { DRIVER_PROTOCOL, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./constants.mjs";
import { invariant } from "./errors.mjs";
import { assertNoSecretKeys } from "./redaction.mjs";
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const integer = (value) => Number.isInteger(value);
export function validateDriverRequest(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "E_REQUEST", "Driver request must be an object");
  invariant(request.protocol_version === DRIVER_PROTOCOL, "E_PROTOCOL_VERSION", `Expected ${DRIVER_PROTOCOL}`);
  for (const key of ["request_id", "run_id", "suite_id", "suite_revision", "suite_digest", "task_id", "task_digest", "prompt", "workspace", "trace_path"]) {
    invariant(nonEmpty(request[key]), "E_REQUEST_FIELD", `Missing or invalid request field: ${key}`);
  }
  invariant(integer(request.trial) && request.trial >= 1, "E_TRIAL", "trial must be an integer >= 1");
  invariant(integer(request.trial_seed) && request.trial_seed >= 0 && request.trial_seed <= 0xffffffff, "E_TRIAL_SEED", "trial_seed must be uint32");
  invariant(integer(request.timeout_ms) && request.timeout_ms >= MIN_TIMEOUT_MS && request.timeout_ms <= MAX_TIMEOUT_MS, "E_TIMEOUT", `timeout_ms must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  invariant(path.isAbsolute(request.workspace), "E_WORKSPACE", "workspace must be absolute");
  invariant(path.isAbsolute(request.trace_path), "E_TRACE_PATH", "trace_path must be absolute");
  validateToolGrant(request.tool_grant);
  return request;
}
export function validateToolGrant(grant) {
  invariant(grant && typeof grant === "object", "E_TOOL_GRANT", "tool_grant is required");
  invariant(["filesystem_baseline", "emacs_operator_candidate"].includes(grant.kind), "E_TOOL_GRANT", "Unsupported tool grant kind");
  invariant(grant.workspace_access === "read_write", "E_TOOL_GRANT", "workspace_access must be read_write");
  invariant(typeof grant.network_access === "string", "E_TOOL_GRANT", "network_access is required");
  invariant(typeof grant.shell_access === "string", "E_TOOL_GRANT", "shell_access is required");
  if (grant.kind === "filesystem_baseline") {
    invariant(grant.emacs_operator === false, "E_TOOL_ISOLATION", "Baseline must not receive Emacs Operator");
    invariant(!grant.mcp_config_path, "E_TOOL_ISOLATION", "Baseline must not receive an MCP config path");
    invariant(Array.isArray(grant.allowed_emacs_tools) && grant.allowed_emacs_tools.length === 0, "E_TOOL_ISOLATION", "Baseline Emacs tool list must be empty");
  } else {
    invariant(grant.emacs_operator === true, "E_TOOL_GRANT", "Candidate must enable Emacs Operator");
    invariant(nonEmpty(grant.mcp_config_path) && path.isAbsolute(grant.mcp_config_path), "E_MCP_CONFIG", "Candidate requires an absolute MCP config path");
    invariant(Array.isArray(grant.allowed_emacs_tools) && grant.allowed_emacs_tools.length > 0, "E_TOOL_GRANT", "Candidate requires an allowed Emacs tool list");
  }
}
export function validateDriverEnvelope(envelope, requestId) {
  invariant(envelope && typeof envelope === "object" && !Array.isArray(envelope), "E_DRIVER_OUTPUT", "Driver output line must be a JSON object");
  invariant(envelope.protocol_version === DRIVER_PROTOCOL, "E_PROTOCOL_VERSION", "Driver response protocol mismatch");
  invariant(envelope.request_id === requestId, "E_REQUEST_ID", "Driver response request_id mismatch");
  invariant(["event", "result"].includes(envelope.kind), "E_DRIVER_OUTPUT", "Driver envelope kind must be event or result");
  assertNoSecretKeys(envelope);
  if (envelope.kind === "event") {
    invariant(envelope.event && typeof envelope.event === "object", "E_DRIVER_EVENT", "event envelope requires event object");
    invariant(nonEmpty(envelope.event.type), "E_DRIVER_EVENT", "event.type is required");
  } else validateDriverResult(envelope.result);
  return envelope;
}
export function validateDriverResult(result) {
  invariant(result && typeof result === "object", "E_DRIVER_RESULT", "result object is required");
  invariant(["completed", "failed", "refused"].includes(result.status), "E_DRIVER_RESULT", "Invalid result.status");
  if (result.summary !== undefined) invariant(typeof result.summary === "string" && Buffer.byteLength(result.summary) <= 65536, "E_DRIVER_RESULT", "summary must be <= 64 KiB");
  if (result.artifacts !== undefined) {
    invariant(Array.isArray(result.artifacts), "E_DRIVER_RESULT", "artifacts must be an array");
    for (const item of result.artifacts) {
      invariant(nonEmpty(item) && !path.isAbsolute(item) && !item.split(/[\/]+/).includes(".."), "E_ARTIFACT_PATH", `Artifact must be workspace-relative: ${item}`);
    }
  }
  if (result.usage !== undefined) {
    invariant(result.usage && typeof result.usage === "object", "E_DRIVER_RESULT", "usage must be an object");
    for (const [key, value] of Object.entries(result.usage)) invariant(Number.isFinite(value) && value >= 0, "E_DRIVER_RESULT", `usage.${key} must be a non-negative number`);
  }
  assertNoSecretKeys(result);
  return result;
}
export function parseDriverJsonLines(stdout, requestId, maxEvents) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  invariant(lines.length > 0, "E_DRIVER_OUTPUT", "Driver produced no JSONL output");
  const events = [];
  let result;
  for (const [index, line] of lines.entries()) {
    let parsed;
    try { parsed = JSON.parse(line); } catch (error) { throw new Error(`Invalid JSON on driver stdout line ${index + 1}: ${error.message}`); }
    const envelope = validateDriverEnvelope(parsed, requestId);
    if (envelope.kind === "event") {
      invariant(events.length < maxEvents, "E_EVENT_LIMIT", `Driver exceeded ${maxEvents} events`);
      events.push(envelope.event);
    } else {
      invariant(result === undefined, "E_MULTIPLE_RESULTS", "Driver emitted more than one result");
      result = envelope.result;
    }
  }
  invariant(result !== undefined, "E_MISSING_RESULT", "Driver did not emit a result envelope");
  return { events, result };
}
