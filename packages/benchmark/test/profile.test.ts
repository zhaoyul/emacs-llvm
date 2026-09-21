import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assertPairedBenchmarkProfiles, benchmarkAgentProfileDescriptor, loadBenchmarkAgentProfile, validateBenchmarkAgentProfile } from "../src/profile.js";
import { temporaryDirectory } from "./helpers.js";

function profile(id: string, toolProfile: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0",
    id,
    revision: "1",
    label: id,
    kind: "llm_experiment",
    pairing_key: "same-model-config",
    provider: "example-provider",
    model: "example-model",
    model_version: "2026-08-31",
    tool_profile: toolProfile,
    prompt_policy: "same-prompts-v1",
    temperature: 0,
    top_p: 1,
    max_context_tokens: 128000,
    cross_trial_memory: "disabled",
    network_access: "disabled",
    ...overrides
  };
}

test("profile loader validates, fingerprints, and emits a non-secret descriptor", () => {
  const root = temporaryDirectory();
  try {
    const file = path.join(root, "profile.json");
    fs.writeFileSync(file, `${JSON.stringify(profile("candidate", "emacs-operator"), null, 2)}\n`);
    const loaded = loadBenchmarkAgentProfile(file);
    assert.equal(loaded.profile.id, "candidate");
    assert.equal(loaded.digest.length, 64);
    const descriptor = benchmarkAgentProfileDescriptor(loaded);
    assert.equal(descriptor.source_file, "profile.json");
    assert.equal(descriptor.digest, loaded.digest);
    assert.equal("path" in descriptor, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("profile validation rejects secret-shaped fields", () => {
  assert.throws(() => validateBenchmarkAgentProfile({ ...profile("candidate", "emacs-operator"), api_key: "do-not-store" }), /secret-bearing field/iu);
  assert.throws(() => validateBenchmarkAgentProfile({ ...profile("candidate", "emacs-operator"), metadata: { password: "do-not-store" } }), /secret-bearing field/iu);
});

test("paired profiles require the same model controls and different tool profiles", () => {
  const root = temporaryDirectory();
  try {
    const baselineFile = path.join(root, "baseline.json");
    const candidateFile = path.join(root, "candidate.json");
    fs.writeFileSync(baselineFile, JSON.stringify(profile("baseline", "filesystem-shell")));
    fs.writeFileSync(candidateFile, JSON.stringify(profile("candidate", "emacs-operator")));
    const baseline = loadBenchmarkAgentProfile(baselineFile);
    const candidate = loadBenchmarkAgentProfile(candidateFile);
    assert.doesNotThrow(() => assertPairedBenchmarkProfiles(baseline, candidate));
    fs.writeFileSync(candidateFile, JSON.stringify(profile("candidate", "emacs-operator", { model: "different-model" })));
    assert.throws(() => assertPairedBenchmarkProfiles(baseline, loadBenchmarkAgentProfile(candidateFile)), /differ in model/iu);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
