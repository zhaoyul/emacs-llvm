import path from "node:path";
import { DEFAULT_CANDIDATE_TOOLS } from "./constants.mjs";
export function createBaselineGrant({ networkAccess = "disabled", shellAccess = "enabled" } = {}) {
  return Object.freeze({
    kind: "filesystem_baseline", workspace_access: "read_write", shell_access: shellAccess,
    network_access: networkAccess, emacs_operator: false, mcp_config_path: null,
    allowed_emacs_tools: Object.freeze([])
  });
}
export function createCandidateGrant({ mcpConfigPath, allowedTools = DEFAULT_CANDIDATE_TOOLS, networkAccess = "disabled", shellAccess = "enabled" }) {
  if (!path.isAbsolute(mcpConfigPath)) throw new Error("mcpConfigPath must be absolute");
  return Object.freeze({
    kind: "emacs_operator_candidate", workspace_access: "read_write", shell_access: shellAccess,
    network_access: networkAccess, emacs_operator: true, mcp_config_path: mcpConfigPath,
    allowed_emacs_tools: Object.freeze([...new Set(allowedTools)].sort())
  });
}
