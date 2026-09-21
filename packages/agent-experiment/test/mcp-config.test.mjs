import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { createEphemeralMcpConfig } from "../src/mcp-config.mjs";
test("ephemeral MCP config is mode 0600 and cleanup removes it",()=>{const x=createEphemeralMcpConfig({command:"node",args:["server.js"],allowedTools:["emacs_observe"]});try{const mode=fs.statSync(x.configPath).mode & 0o777;assert.equal(mode,0o600);const cfg=JSON.parse(fs.readFileSync(x.configPath,"utf8"));assert.ok(cfg.mcpServers["emacs-operator"].env.EMACS_OPERATOR_EXPERIMENT_TOKEN);assert.equal(cfg.mcpServers["emacs-operator"].allowed_tools[0],"emacs_observe");}finally{x.cleanup();}assert.equal(fs.existsSync(x.configPath),false);});
