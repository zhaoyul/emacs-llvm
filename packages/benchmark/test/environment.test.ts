import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutable, taskAvailability } from "../src/environment.js";
import type { BenchmarkTask } from "../src/types.js";

function task(requirements: NonNullable<BenchmarkTask["requirements"]>): BenchmarkTask {
  return {
    id: "environment-test",
    title: "Environment test",
    domain: "mixed",
    category: "evaluation",
    difficulty: "small",
    prompt_file: "prompt.md",
    fixture_dir: "fixture",
    checks: [],
    requirements
  };
}

test("findExecutable resolves an executable absolute path", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eo-benchmark-env-"));
  try {
    const executable = path.join(directory, "probe");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    assert.equal(findExecutable(executable), executable);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("taskAvailability reports executable, platform, and environment requirements without pretending availability", () => {
  const missing = `EMACS_OPERATOR_BENCHMARK_MISSING_${process.pid}`;
  delete process.env[missing];
  const unavailable = taskAvailability(task({
    executables: ["definitely-not-an-emacs-operator-executable"],
    platforms: [process.platform],
    environment: [missing]
  }));
  assert.equal(unavailable.available, false);
  assert.ok(unavailable.reasons.some((reason) => reason.includes("missing executable")));
  assert.ok(unavailable.reasons.some((reason) => reason.includes("missing environment variable")));

  const available = taskAvailability(task({ executables: [process.execPath], platforms: [process.platform] }));
  assert.deepEqual(available, { available: true, reasons: [] });
});
