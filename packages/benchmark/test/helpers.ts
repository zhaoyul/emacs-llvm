import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function temporaryDirectory(prefix = "emacs-benchmark-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeSuite(root: string, options: { commandCheck?: boolean; requirements?: Record<string, unknown>; protectedPaths?: string[]; allowedPaths?: string[] } = {}): string {
  fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(root, "fixtures", "answer"), { recursive: true });
  fs.writeFileSync(path.join(root, "prompts", "answer.md"), "Change answer.txt from 40 to 42.\n");
  fs.writeFileSync(path.join(root, "fixtures", "answer", "answer.txt"), "40\n");
  fs.writeFileSync(path.join(root, "fixtures", "answer", "protected.txt"), "do not change\n");
  const checks: unknown[] = [
    { id: "answer", type: "exact_text", path: "answer.txt", expected_text: "42\n", weight: 3, required: true },
    { id: "protected", type: "file_unchanged", path: "protected.txt", required: true }
  ];
  if (options.commandCheck) checks.push({ id: "command", type: "command", command: [process.execPath, "-e", "process.exit(0)"], required: true });
  const suite = {
    schema_version: "1.0",
    id: "synthetic-answer",
    revision: "1",
    title: "Synthetic answer",
    defaults: { trials: 1, timeout_ms: 5000, pass_threshold: 1, max_workspace_bytes: 1024 * 1024 },
    tasks: [{
      id: "answer",
      title: "Answer",
      domain: "mixed",
      category: "repair",
      difficulty: "small",
      prompt_file: "prompts/answer.md",
      fixture_dir: "fixtures/answer",
      ...(options.requirements ? { requirements: options.requirements } : {}),
      ...(options.protectedPaths ? { protected_paths: options.protectedPaths } : {}),
      ...(options.allowedPaths ? { allowed_paths: options.allowedPaths } : {}),
      checks
    }]
  };
  const file = path.join(root, "suite.json");
  fs.writeFileSync(file, `${JSON.stringify(suite, null, 2)}\n`);
  return file;
}
