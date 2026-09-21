import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Bytes } from "./hash.js";
import type { BenchmarkAgentProfile, LoadedBenchmarkAgentProfile } from "./types.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROFILE_KINDS = new Set<BenchmarkAgentProfile["kind"]>(["deterministic_harness_probe", "llm_experiment", "custom"]);
const MEMORY_POLICIES = new Set<NonNullable<BenchmarkAgentProfile["cross_trial_memory"]>>(["disabled", "enabled", "unknown"]);
const NETWORK_POLICIES = new Set<NonNullable<BenchmarkAgentProfile["network_access"]>>(["disabled", "enabled", "unknown"]);
const FORBIDDEN_KEYS = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|password|private[_-]?key|secret)/iu;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  if (value.length > maximum) throw new TypeError(`${label} exceeds ${maximum} characters.`);
  return value;
}

function optionalText(value: unknown, label: string, maximum = 4096): string | undefined {
  return value === undefined ? undefined : boundedText(value, label, maximum);
}

function optionalFinite(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`${label} must be between ${minimum} and ${maximum}.`);
  return value;
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  const number = optionalFinite(value, label, minimum, maximum);
  if (number !== undefined && !Number.isInteger(number)) throw new TypeError(`${label} must be an integer.`);
  return number;
}

function rejectSecrets(value: unknown, location = "profile"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecrets(item, `${location}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.test(key)) throw new TypeError(`${location}.${key} looks like a secret-bearing field and must not be stored in a benchmark profile.`);
    rejectSecrets(child, `${location}.${key}`);
  }
}

export function validateBenchmarkAgentProfile(value: unknown): BenchmarkAgentProfile {
  rejectSecrets(value);
  const input = record(value, "benchmark agent profile");
  if (input.schema_version !== "1.0") throw new TypeError("benchmark agent profile schema_version must be 1.0.");
  const id = boundedText(input.id, "profile.id", 128);
  if (!ID_PATTERN.test(id)) throw new TypeError("profile.id must use letters, digits, dot, underscore, or hyphen.");
  const revision = boundedText(input.revision, "profile.revision", 128);
  const label = boundedText(input.label, "profile.label", 256);
  const kind = boundedText(input.kind, "profile.kind", 64) as BenchmarkAgentProfile["kind"];
  if (!PROFILE_KINDS.has(kind)) throw new TypeError(`Unsupported profile.kind: ${kind}`);
  const toolProfile = boundedText(input.tool_profile, "profile.tool_profile", 256);
  const promptPolicy = boundedText(input.prompt_policy, "profile.prompt_policy", 256);
  const pairingKey = optionalText(input.pairing_key, "profile.pairing_key", 256);
  const provider = optionalText(input.provider, "profile.provider", 256);
  const model = optionalText(input.model, "profile.model", 256);
  const modelVersion = optionalText(input.model_version, "profile.model_version", 256);
  const temperature = optionalFinite(input.temperature, "profile.temperature", 0, 100);
  const topP = optionalFinite(input.top_p, "profile.top_p", 0, 1);
  const maxContextTokens = optionalInteger(input.max_context_tokens, "profile.max_context_tokens", 1, 100_000_000);
  const crossTrialMemory = input.cross_trial_memory === undefined ? undefined : boundedText(input.cross_trial_memory, "profile.cross_trial_memory", 32) as BenchmarkAgentProfile["cross_trial_memory"];
  if (crossTrialMemory !== undefined && !MEMORY_POLICIES.has(crossTrialMemory)) throw new TypeError(`Unsupported profile.cross_trial_memory: ${crossTrialMemory}`);
  const networkAccess = input.network_access === undefined ? undefined : boundedText(input.network_access, "profile.network_access", 32) as BenchmarkAgentProfile["network_access"];
  if (networkAccess !== undefined && !NETWORK_POLICIES.has(networkAccess)) throw new TypeError(`Unsupported profile.network_access: ${networkAccess}`);
  let notes: string[] | undefined;
  if (input.notes !== undefined) {
    if (!Array.isArray(input.notes) || input.notes.length > 64) throw new TypeError("profile.notes must be an array with at most 64 entries.");
    notes = input.notes.map((item, index) => boundedText(item, `profile.notes[${index}]`, 2048));
  }
  const description = optionalText(input.description, "profile.description", 8192);
  return {
    schema_version: "1.0",
    id,
    revision,
    label,
    kind,
    tool_profile: toolProfile,
    prompt_policy: promptPolicy,
    ...(pairingKey !== undefined ? { pairing_key: pairingKey } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(modelVersion !== undefined ? { model_version: modelVersion } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    ...(maxContextTokens !== undefined ? { max_context_tokens: maxContextTokens } : {}),
    ...(crossTrialMemory !== undefined ? { cross_trial_memory: crossTrialMemory } : {}),
    ...(networkAccess !== undefined ? { network_access: networkAccess } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(notes !== undefined ? { notes } : {})
  };
}

export function loadBenchmarkAgentProfile(file: string): LoadedBenchmarkAgentProfile {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("Benchmark agent profile must be a regular, non-symbolic-link JSON file.");
  const profile = validateBenchmarkAgentProfile(JSON.parse(fs.readFileSync(resolved, "utf8")));
  return {
    profile,
    path: resolved,
    digest: sha256Bytes(canonicalJson(profile))
  };
}

export function benchmarkAgentProfileDescriptor(loaded: LoadedBenchmarkAgentProfile): Record<string, unknown> {
  return {
    ...loaded.profile,
    digest: loaded.digest,
    source_file: path.basename(loaded.path)
  };
}

export function assertPairedBenchmarkProfiles(baseline: LoadedBenchmarkAgentProfile, candidate: LoadedBenchmarkAgentProfile): void {
  if (!baseline.profile.pairing_key || !candidate.profile.pairing_key) throw new TypeError("Paired LLM experiments require pairing_key in both agent profiles.");
  if (baseline.profile.pairing_key !== candidate.profile.pairing_key) throw new TypeError("Paired agent profiles must use the same pairing_key.");
  const comparableFields = ["kind", "provider", "model", "model_version", "prompt_policy", "temperature", "top_p", "max_context_tokens", "cross_trial_memory", "network_access"] as const;
  for (const field of comparableFields) {
    if (baseline.profile[field] !== candidate.profile[field]) throw new TypeError(`Paired agent profiles differ in ${field}. Only the tool profile should differ in a controlled comparison.`);
  }
  if (baseline.profile.tool_profile === candidate.profile.tool_profile) throw new TypeError("Paired agent profiles must use different tool_profile values.");
}
