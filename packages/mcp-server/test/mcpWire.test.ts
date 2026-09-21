import test from "node:test";
import assert from "node:assert/strict";
import { McpWireServer } from "../src/mcpWireServer.js";
import { EMACS_OPERATOR_VERSION } from "../../protocol/src/index.js";

test("MCP initialize negotiates a supported protocol and advertises tools", async () => {
  const server = new McpWireServer();
  const initialized = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } });
  assert.equal((initialized?.result as any).protocolVersion, "2026-07-28");
  assert.equal((initialized?.result as any).serverInfo.version, EMACS_OPERATOR_VERSION);
  const listed = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = ((listed?.result as any).tools as any[]).map((tool) => tool.name);
  assert.ok(names.includes("emacs_health"));
  assert.ok(names.includes("emacs_key_sequence"));
  assert.ok(names.includes("emacs_read"));
  assert.ok(names.includes("emacs_navigate"));
  assert.ok(names.includes("emacs_validate"));
  assert.ok(names.includes("emacs_analyze"));
  assert.ok(names.includes("emacs_project_rename"));
  assert.ok(names.includes("emacs_verification"));
  assert.ok(names.includes("emacs_workflow"));
  assert.ok(names.includes("emacs_rollback"));
  const workflow = ((listed?.result as any).tools as any[]).find((tool) => tool.name === "emacs_workflow");
  const workflowOps = workflow.inputSchema.properties.operation.enum as string[];
  for (const operation of ["rename_symbol", "extract_function", "move_form", "transform_sexp", "org_rewrite_subtree"]) {
    assert.ok(workflowOps.includes(operation), `workflow schema missing ${operation}`);
  }
  assert.equal(workflow.inputSchema.properties.range.properties.start.type, "integer");
  assert.equal(workflow.inputSchema.properties.rewrite.properties.expected_title.type, "string");
});

test("health tool works without Emacs", async () => {
  const server = new McpWireServer();
  const response = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "emacs_health", arguments: {} } });
  const result = response?.result as any;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.result.channels.internal_keys, true);
  assert.equal(result.structuredContent.result.channels.native_keys, false);
});

test("capture tool result is exposed as MCP image content without duplicating base64 in structuredContent", async () => {
  const fakeRouter = {
    call: async () => ({
      ok: true,
      request_id: "req_capture",
      audit_id: "audit_capture",
      result: {
        width: 1,
        height: 1,
        bytes: 8,
        mime_type: "image/png",
        image_data: "iVBORw0KGgo=",
        transient_file_consumed: true
      }
    })
  };
  const server = new McpWireServer(fakeRouter as any);
  const response = await server.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "emacs_capture", arguments: { session_id: "x" } } });
  const result = response?.result as any;
  assert.equal(result.isError, false);
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/png");
  assert.equal(result.content[1].data, "iVBORw0KGgo=");
  assert.equal("image_data" in result.structuredContent.result, false);
});
