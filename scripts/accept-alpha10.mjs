#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const reportPath = process.env.EMACS_OPERATOR_ALPHA10_REPORT || path.join(root, "artifacts", "alpha10-acceptance.json");
const results = [];

function run(name, command, args = [], { required = true, cwd = root, env = {} } = {}) {
  const started = Date.now();
  const cp = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1", ...env },
    maxBuffer: 16 * 1024 * 1024
  });
  const output = `${cp.stdout ?? ""}${cp.stderr ?? ""}`;
  const item = {
    name,
    command: [command, ...args],
    exit_code: cp.status ?? 125,
    ok: cp.status === 0,
    required,
    seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    output_tail: output.slice(-6000)
  };
  results.push(item);
  return item;
}

function markerCheck(name, checks) {
  const item = { name, required: true, ok: Object.values(checks).every(Boolean), checks };
  results.push(item);
  return item;
}

run("version-consistency", process.execPath, ["scripts/sync-version.mjs", "--check"]);
run("elisp-lexical-structure", "python3", ["scripts/check-elisp-structure.py"]);
run("typescript-typecheck", "npm", ["run", "typecheck"]);
run("typescript-main-tests", "npm", ["run", "test:ts"]);

const intelligenceTests = readdirSync(path.join(root, "packages", "refactor-intelligence", "test"))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join("packages", "refactor-intelligence", "test", name));
run("refactor-intelligence-tests", process.execPath, ["--test", ...intelligenceTests]);

run("swift-portable-tests", "swift", ["test", "--package-path", "apps/macos-host"]);
run("shell-syntax", "bash", ["-lc", "set -e; for f in scripts/*.sh; do bash -n \"$f\"; done"]);

const generic = readFileSync(path.join(root, "lisp", "adapters", "emacs-operator-adapter-generic.el"), "utf8");
const bridge = readFileSync(path.join(root, "lisp", "emacs-operator-bridge.el"), "utf8");
const intelligence = readFileSync(path.join(root, "lisp", "emacs-operator-refactor-intelligence.el"), "utf8");
const catalog = readFileSync(path.join(root, "packages", "mcp-server", "src", "tools", "catalog.ts"), "utf8");
const router = readFileSync(path.join(root, "packages", "mcp-server", "src", "tools", "toolRouter.ts"), "utf8");
const repl = readFileSync(path.join(root, "lisp", "adapters", "emacs-operator-adapter-repl.el"), "utf8");
const cider = readFileSync(path.join(root, "lisp", "adapters", "emacs-operator-adapter-cider.el"), "utf8");
const sly = readFileSync(path.join(root, "lisp", "adapters", "emacs-operator-adapter-sly.el"), "utf8");
markerCheck("alpha10-integration-markers", {
  generic_analyzer_slot: generic.includes("analyzer") && generic.includes("emacs-operator-adapters-analyze"),
  bridge_analysis_rpc: bridge.includes('"adapter.analyze"') && bridge.includes("emacs-operator-adapter-analyze"),
  bridge_project_rename_rpc: bridge.includes('"refactor.project_rename"'),
  project_rename_preview: intelligence.includes("emacs-operator-project-rename-preview"),
  project_rename_journal: intelligence.includes("emacs-operator--project-rename-journals"),
  project_rename_rollback: intelligence.includes("emacs-operator-project-rename-rollback"),
  enclosing_binding_analysis: intelligence.includes("emacs-operator--alpha10-enclosing-lexical-bindings"),
  evaluation_fingerprint_analysis: intelligence.includes("evaluation_source_fingerprint"),
  evaluation_source_locator: repl.includes("source_start") && repl.includes("source_bounds") && router.includes("source_target_changed"),
  rename_journal_built_before_group_accept: intelligence.includes("Build the rollback journal while every change group is still") && intelligence.includes("before any of them has been accepted"),
  mcp_analysis_tool: catalog.includes('name: "emacs_analyze"') && router.includes('name === "emacs_analyze"'),
  mcp_project_rename_tool: catalog.includes('name: "emacs_project_rename"') && router.includes('name === "emacs_project_rename"'),
  mcp_verification_tool: catalog.includes('name: "emacs_verification"') && router.includes('name === "emacs_verification"'),
  repl_source_metadata: repl.includes("source_sha256") && repl.includes("source_bytes") && repl.includes("source_start"),
  cider_source_metadata: cider.includes("emacs-operator-repl-source-metadata"),
  sly_source_metadata: sly.includes("emacs-operator-repl-source-metadata")
});

const emacsProbe = spawnSync("emacs", ["--version"], { encoding: "utf8" });
if (emacsProbe.status === 0) {
  run("ert", "npm", ["run", "test:elisp"]);
} else {
  results.push({ name: "ert", required: false, ok: false, status: "not_run", reason: "GNU Emacs 29+ is unavailable in this environment." });
}

const bundlePath = path.join(root, "dist", `emacs-operator-${version}.mcpb`);
run("mcpb-package", "bash", ["scripts/package-mcpb.sh", bundlePath]);
run("mcpb-zip-integrity", "python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); print('files=%d'%len(z.namelist())); assert bad is None, bad", bundlePath]);

async function smokeBundle() {
  const stage = mkdtempSync(path.join(os.tmpdir(), "emacs-operator-alpha10-mcpb-"));
  try {
    const unzip = spawnSync("python3", ["-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", bundlePath, stage], { encoding: "utf8" });
    if (unzip.status !== 0) return { name: "mcpb-extracted-server-smoke", required: true, ok: false, reason: unzip.stderr || "bundle extraction failed" };
    const entry = path.join(stage, "server", "packages", "mcp-server", "src", "server.js");
    if (!existsSync(entry)) return { name: "mcpb-extracted-server-smoke", required: true, ok: false, reason: "server entry point missing after extraction" };
    const child = spawn(process.execPath, [entry], { cwd: stage, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const responses = [];
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) continue;
        try { responses.push(JSON.parse(line)); } catch {}
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "emacs_health", arguments: {} } }) + "\n");
    const deadline = Date.now() + 5000;
    while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    const init = responses.find((response) => response.id === 1);
    const health = responses.find((response) => response.id === 2);
    const initVersion = init?.result?.serverInfo?.version;
    const healthOk = health?.result?.structuredContent?.ok === true;
    return {
      name: "mcpb-extracted-server-smoke",
      required: true,
      ok: initVersion === version && healthOk,
      initialize_version: initVersion ?? null,
      health_ok: healthOk,
      stderr_tail: stderr.slice(-2000)
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
results.push(await smokeBundle());

const requiredOk = results.filter((item) => item.required).every((item) => item.ok === true);
const report = {
  version,
  suite: "alpha10",
  ok: requiredOk,
  generated_at: new Date().toISOString(),
  runtime_acceptance: {
    emacs_ert: emacsProbe.status === 0 ? "executed" : "not_run",
    macos_native: process.platform === "darwin" ? "not_part_of_alpha10_portable_suite" : "not_run_on_non_macos"
  },
  results
};
mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
process.exit(requiredOk ? 0 : 1);
