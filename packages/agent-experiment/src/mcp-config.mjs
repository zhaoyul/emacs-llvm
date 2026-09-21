import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sha256 } from "./canonical.mjs";
import { invariant } from "./errors.mjs";
export function createEphemeralMcpConfig({ command, args = [], env = {}, allowedTools, rootDirectory, prefix = "emacs-operator-mcp-" }) {
  invariant(typeof command === "string" && command.length > 0, "E_MCP_COMMAND", "MCP command is required");
  invariant(Array.isArray(args) && args.every((value) => typeof value === "string"), "E_MCP_ARGS", "MCP args must be strings");
  const directory = fs.mkdtempSync(path.join(rootDirectory ?? os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  const authToken = randomBytes(32).toString("hex");
  const config = {
    schema_version: "1.0",
    mcpServers: {
      "emacs-operator": {
        transport: "stdio",
        command,
        args,
        env: { ...env, EMACS_OPERATOR_EXPERIMENT_TOKEN: authToken },
        allowed_tools: [...allowedTools]
      }
    }
  };
  const configPath = path.join(directory, "mcp-config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}
`, { mode: 0o600 });
  return {
    configPath,
    directory,
    digest: sha256(fs.readFileSync(configPath)),
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); }
  };
}
