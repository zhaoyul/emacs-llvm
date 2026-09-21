import { SECRET_KEY_PATTERN, SENSITIVE_ENV_PATTERN } from "./constants.mjs";
const REDACTED = "[REDACTED]";
export function redact(value, key = "") {
  if (SECRET_KEY_PATTERN.test(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) out[childKey] = redact(childValue, childKey);
    return out;
  }
  return value;
}
export function assertNoSecretKeys(value, path = "$") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) throw new Error(`Secret-like key is forbidden in protocol output: ${path}.${key}`);
    assertNoSecretKeys(child, `${path}.${key}`);
  }
}
export function sanitizeEnvironmentForReport(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) out[key] = SENSITIVE_ENV_PATTERN.test(key) ? REDACTED : value;
  return out;
}
export function truncateText(text, maxBytes) {
  const data = Buffer.from(String(text));
  if (data.length <= maxBytes) return { text: data.toString("utf8"), truncated: false, bytes: data.length };
  return { text: data.subarray(0, maxBytes).toString("utf8"), truncated: true, bytes: data.length };
}
