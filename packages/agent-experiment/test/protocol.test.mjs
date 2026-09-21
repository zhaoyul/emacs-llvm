import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { DRIVER_PROTOCOL } from "../src/constants.mjs";
import { parseDriverJsonLines, validateDriverRequest, validateDriverResult } from "../src/protocol.mjs";

const base = (grant) => ({
  protocol_version: DRIVER_PROTOCOL,
  request_id: "r",
  run_id: "run",
  suite_id: "s",
  suite_revision: "1",
  suite_digest: "d",
  task_id: "t",
  task_digest: "td",
  trial: 1,
  trial_seed: 1,
  prompt: "p",
  workspace: os.tmpdir(),
  timeout_ms: 1000,
  trace_path: path.join(os.tmpdir(), "t.jsonl"),
  tool_grant: grant
});

test("baseline grant excludes MCP", () => assert.doesNotThrow(() => validateDriverRequest(base({
  kind: "filesystem_baseline", workspace_access: "read_write", shell_access: "enabled",
  network_access: "disabled", emacs_operator: false, mcp_config_path: null, allowed_emacs_tools: []
}))));

test("baseline MCP leak rejected", () => assert.throws(() => validateDriverRequest(base({
  kind: "filesystem_baseline", workspace_access: "read_write", shell_access: "enabled",
  network_access: "disabled", emacs_operator: false, mcp_config_path: "/tmp/x", allowed_emacs_tools: []
})), /must not receive/));

test("candidate requires MCP config", () => assert.throws(() => validateDriverRequest(base({
  kind: "emacs_operator_candidate", workspace_access: "read_write", shell_access: "enabled",
  network_access: "disabled", emacs_operator: true, allowed_emacs_tools: ["x"]
})), /requires/));

test("artifact path escape rejected", () => assert.throws(() =>
  validateDriverResult({ status: "completed", artifacts: ["../oracle.json"] }), /workspace-relative/));

test("secret-like result key rejected", () => assert.throws(() =>
  validateDriverResult({ status: "completed", metadata: { api_key: "x" } }), /Secret-like key/));

test("JSONL parser accepts events plus one result", () => {
  const stdout = [
    { protocol_version: DRIVER_PROTOCOL, request_id: "r", kind: "event", event: { type: "x" } },
    { protocol_version: DRIVER_PROTOCOL, request_id: "r", kind: "result", result: { status: "completed" } }
  ].map(JSON.stringify).join("\n");
  const parsed = parseDriverJsonLines(stdout, "r", 3);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.result.status, "completed");
});

test("JSONL parser rejects multiple results", () => {
  const line = JSON.stringify({
    protocol_version: DRIVER_PROTOCOL, request_id: "r", kind: "result", result: { status: "completed" }
  });
  assert.throws(() => parseDriverJsonLines(`${line}\n${line}`, "r", 3), /more than one/);
});
