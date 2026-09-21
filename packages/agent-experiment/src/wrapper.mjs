import fs from "node:fs";
import path from "node:path";
import { DRIVER_PROTOCOL, DEFAULT_TIMEOUT_MS, DEFAULT_CANDIDATE_TOOLS } from "./constants.mjs";
import { requestId, sha256 } from "./canonical.mjs";
import { buildDriverEnvironment, environmentDisclosure } from "./environment.mjs";
import { createBaselineGrant, createCandidateGrant } from "./tool-grants.mjs";
import { createEphemeralMcpConfig } from "./mcp-config.mjs";
import { invokeProcessDriver } from "./process-driver.mjs";
import { TraceWriter, traceDigest } from "./trace.mjs";
import { validateDriverRequest } from "./protocol.mjs";
function profileForRequest(profile) {
  const { command, args, env_passthrough, secret_env_names, ...safe } = profile;
  return safe;
}
function makeRequest(base, profile, grant) {
  const request = {
    protocol_version: DRIVER_PROTOCOL,
    request_id: base.request_id ?? requestId(),
    run_id: base.run_id,
    suite_id: base.suite_id,
    suite_revision: base.suite_revision,
    suite_digest: base.suite_digest,
    task_id: base.task_id,
    task_digest: base.task_digest,
    trial: base.trial,
    trial_seed: base.trial_seed,
    prompt: base.prompt,
    workspace: path.resolve(base.workspace),
    timeout_ms: base.timeout_ms ?? profile.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    trace_path: path.resolve(base.trace_path),
    agent_profile: profileForRequest(profile),
    tool_grant: grant
  };
  return validateDriverRequest(request);
}
export function createFilesystemBaselineAgent(profile) {
  return createAgent("baseline", profile);
}
export function createEmacsOperatorCandidateAgent(profile) {
  return createAgent("candidate", profile);
}
function createAgent(kind, profile) {
  if (!profile || typeof profile !== "object") throw new Error("Agent profile is required");
  if (typeof profile.command !== "string" || profile.command.length === 0) throw new Error("profile.command is required");
  return Object.freeze({
    kind,
    id: profile.id,
    async run(base) {
      let ephemeral;
      const trace = new TraceWriter(path.resolve(base.trace_path), { includePrompt: profile.include_prompt_in_trace === true });
      try {
        let grant;
        const additions = { EMACS_OPERATOR_AGENT_MODE: kind, EMACS_OPERATOR_TRIAL_SEED: String(base.trial_seed) };
        if (kind === "candidate") {
          ephemeral = createEphemeralMcpConfig({
            command: profile.mcp?.command ?? process.execPath,
            args: profile.mcp?.args ?? [],
            env: profile.mcp?.env ?? {},
            allowedTools: profile.allowed_emacs_tools ?? DEFAULT_CANDIDATE_TOOLS,
            rootDirectory: profile.private_runtime_root
          });
          grant = createCandidateGrant({
            mcpConfigPath: ephemeral.configPath,
            allowedTools: profile.allowed_emacs_tools ?? DEFAULT_CANDIDATE_TOOLS,
            networkAccess: profile.network_access ?? "disabled",
            shellAccess: profile.shell_access ?? "enabled"
          });
          additions.EMACS_OPERATOR_MCP_CONFIG = ephemeral.configPath;
        } else {
          grant = createBaselineGrant({ networkAccess: profile.network_access ?? "disabled", shellAccess: profile.shell_access ?? "enabled" });
        }
        const request = makeRequest(base, profile, grant);
        const env = buildDriverEnvironment({
          passthrough: profile.env_passthrough ?? [],
          secretEnvNames: profile.secret_env_names ?? [],
          additions,
          baseline: kind === "baseline"
        });
        trace.write("trial.start", {
          request_id: request.request_id, run_id: request.run_id, task_id: request.task_id, trial: request.trial,
          trial_seed: request.trial_seed, prompt: request.prompt, tool_profile: grant.kind,
          profile_digest: sha256(profileForRequest(profile)), environment: environmentDisclosure(env),
          ...(ephemeral ? { mcp_config_digest: ephemeral.digest } : {})
        });
        const invocation = await invokeProcessDriver({ request, command: profile.command, args: profile.args ?? [], env, trace });
        trace.write("trial.finish", { request_id: request.request_id, status: invocation.result.status });
        await trace.close();
        return {
          status: invocation.result.status,
          summary: invocation.result.summary ?? "",
          usage: invocation.result.usage,
          artifacts: invocation.result.artifacts ?? [],
          metadata: invocation.result.metadata ?? {},
          driver_events: invocation.events,
          process: invocation.process,
          trace_path: request.trace_path,
          trace_sha256: traceDigest(request.trace_path),
          tool_profile: grant.kind,
          request_id: request.request_id
        };
      } catch (error) {
        trace.write("trial.error", { error: { name: error?.name, code: error?.code, message: error?.message } });
        await trace.close();
        throw error;
      } finally { ephemeral?.cleanup(); }
    }
  });
}
