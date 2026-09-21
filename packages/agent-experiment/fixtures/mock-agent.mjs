#!/usr/bin/env node
import fs from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input.trim());
const envelope = (kind, payload) => ({
  protocol_version: request.protocol_version,
  request_id: request.request_id,
  kind,
  ...payload
});

process.stdout.write(`${JSON.stringify(envelope("event", {
  event: { type: "request.accepted", tool_profile: request.tool_grant.kind }
}))}\n`);

if (process.env.MOCK_AGENT_DELAY_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.MOCK_AGENT_DELAY_MS)));
}

if (
  process.env.MOCK_AGENT_EXPECT_MODE &&
  process.env.EMACS_OPERATOR_AGENT_MODE !== process.env.MOCK_AGENT_EXPECT_MODE
) {
  process.stderr.write("wrong mode\n");
  process.exit(8);
}

if (
  request.tool_grant.kind === "filesystem_baseline" &&
  (process.env.EMACS_OPERATOR_MCP_CONFIG || request.tool_grant.mcp_config_path)
) {
  process.stderr.write("baseline leaked MCP config\n");
  process.exit(9);
}

if (request.tool_grant.kind === "emacs_operator_candidate") {
  if (
    !process.env.EMACS_OPERATOR_MCP_CONFIG ||
    !fs.existsSync(process.env.EMACS_OPERATOR_MCP_CONFIG)
  ) {
    process.stderr.write("candidate missing MCP config\n");
    process.exit(10);
  }
  const config = JSON.parse(fs.readFileSync(process.env.EMACS_OPERATOR_MCP_CONFIG, "utf8"));
  if (!config.mcpServers?.["emacs-operator"]) {
    process.stderr.write("bad MCP config\n");
    process.exit(11);
  }
}

if (process.env.MOCK_AGENT_WRITE) {
  fs.writeFileSync(process.env.MOCK_AGENT_WRITE, `${request.task_id}:${request.trial_seed}\n`);
}

process.stdout.write(`${JSON.stringify(envelope("result", {
  result: {
    status: "completed",
    summary: `mock ${request.tool_grant.kind}`,
    usage: { input_tokens: 10, output_tokens: 5 },
    artifacts: [],
    metadata: { mode: request.tool_grant.kind }
  }
}))}\n`);
