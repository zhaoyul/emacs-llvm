import { SAFE_INHERITED_ENV, SENSITIVE_ENV_PATTERN } from "./constants.mjs";
import { invariant } from "./errors.mjs";
export function buildDriverEnvironment({ baseEnv = process.env, passthrough = [], secretEnvNames = [], additions = {}, baseline = false }) {
  const env = {};
  const allowed = new Set([...SAFE_INHERITED_ENV, ...passthrough, ...secretEnvNames]);
  for (const key of allowed) if (baseEnv[key] !== undefined) env[key] = String(baseEnv[key]);
  for (const [key, value] of Object.entries(additions)) {
    invariant(typeof value === "string", "E_ENV_VALUE", `Environment value for ${key} must be a string`);
    env[key] = value;
  }
  if (baseline) {
    for (const key of Object.keys(env)) {
      if (/^(?:EMACS_OPERATOR|MCP)(?:_|$)/i.test(key)) delete env[key];
    }
  }
  return env;
}
export function environmentDisclosure(env) {
  return Object.keys(env).sort().map((name) => ({ name, sensitive: SENSITIVE_ENV_PATTERN.test(name) }));
}
