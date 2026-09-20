#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
if (process.platform !== "linux") {
  process.stderr.write("accept:alpha13 is the Linux release gate and must run on Linux. Use accept:macos on macOS.\n");
  process.exit(64);
}

const stamp = new Date().toISOString().replace(/[-:.]/g, "");
const reportDirectory = path.resolve(process.env.EMACS_OPERATOR_ALPHA13_REPORT_DIR ?? path.join(root, "dist", "acceptance", `alpha13-${stamp}`));
fs.mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
fs.chmodSync(reportDirectory, 0o700);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-alpha13-release."));
const checks = [];
let failedStage = null;

function run(name, command, args, options = {}) {
  const log = path.join(reportDirectory, `${name}.log`);
  process.stdout.write(`RUN   ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 20 * 60 * 1000
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  fs.writeFileSync(log, output, { mode: 0o600 });
  const item = {
    name,
    command: [command, ...args],
    status: result.status === 0 && !result.error ? "pass" : "fail",
    exit_code: result.status,
    signal: result.signal ?? null,
    log: path.basename(log)
  };
  checks.push(item);
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `exit code ${String(result.status)}${result.signal ? ` (${result.signal})` : ""}`;
    throw new Error(`${name} failed: ${reason}. See ${log}.`);
  }
  process.stdout.write(`PASS  ${name}\n`);
  return item;
}

function sendMcpRequests(entryPoint) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPoint], { cwd: path.dirname(entryPoint), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill(error ? "SIGKILL" : "SIGTERM");
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Extracted MCPB server smoke timed out.")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2 || settled) return;
      try {
        const messages = lines.map((line) => JSON.parse(line));
        const initialized = messages.find((message) => message.id === 1);
        const health = messages.find((message) => message.id === 2);
        if (!initialized?.result?.serverInfo || initialized.result.serverInfo.version !== version) {
          throw new Error(`Extracted MCPB initialize reported an unexpected version: ${JSON.stringify(initialized)}`);
        }
        const healthText = health?.result?.content?.[0]?.text;
        if (typeof healthText !== "string") throw new Error(`Extracted MCPB health response is malformed: ${JSON.stringify(health)}`);
        finish(null, { initialize: initialized.result.serverInfo, health: JSON.parse(healthText) });
      } catch (error) {
        finish(error);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled && code !== 0) finish(new Error(`Extracted MCPB server exited early (${String(code)}): ${stderr.slice(-2000)}`));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "alpha13-release-smoke", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "emacs_health", arguments: {} } })}\n`);
  });
}

async function main() {
  const startedAt = new Date().toISOString();
  let extractedSmoke = null;
  let linuxHostBundleReport = null;
  try {
    failedStage = "linux_acceptance";
    run("linux-acceptance", "bash", ["scripts/accept-linux.sh"], {
      env: { EMACS_OPERATOR_LINUX_ACCEPTANCE_REPORT_DIR: path.join(reportDirectory, "linux") }
    });

    failedStage = "sanitizer_acceptance";
    run("linux-sanitized", "bash", ["scripts/accept-linux-sanitized.sh"], {
      env: { EMACS_OPERATOR_LINUX_SANITIZER_REPORT_DIR: path.join(reportDirectory, "sanitized") }
    });

    failedStage = "linux_host_bundle";
    const architecture = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim() || process.arch;
    const linuxHostBundle = path.join(reportDirectory, `emacs-operator-linux-host-${version}-linux-${architecture}.tar.gz`);
    const linuxHostBundleReportPath = path.join(reportDirectory, "linux-host-bundle.json");
    run("linux-host-bundle-package", "bash", ["scripts/package-linux-host.sh", linuxHostBundle]);
    run("linux-host-bundle-integrity", "tar", ["-tzf", linuxHostBundle]);
    run("linux-host-bundle-smoke", "bash", ["scripts/verify-linux-host-bundle.sh", linuxHostBundle, linuxHostBundleReportPath]);
    linuxHostBundleReport = JSON.parse(fs.readFileSync(linuxHostBundleReportPath, "utf8"));
    if (linuxHostBundleReport.ok !== true) throw new Error("Standalone Linux Host bundle report is not green.");

    failedStage = "mcpb_packaging";
    const mcpb = path.join(reportDirectory, `emacs-operator-${version}.mcpb`);
    run("mcpb-package", "bash", ["scripts/package-mcpb.sh", mcpb]);
    run("mcpb-integrity", "python3", ["-m", "zipfile", "-t", mcpb]);

    failedStage = "mcpb_extracted_smoke";
    const extracted = path.join(temporary, "mcpb");
    fs.mkdirSync(extracted, { recursive: true });
    run("mcpb-extract", "python3", ["-m", "zipfile", "-e", mcpb, extracted]);
    const forbiddenPackages = ["benchmark", "test-harness"].filter((name) => fs.existsSync(path.join(extracted, "server", "packages", name)));
    if (forbiddenPackages.length) throw new Error(`Development-only MCPB packages were included: ${forbiddenPackages.join(", ")}`);
    const packageRoot = path.join(extracted, "server", "packages");
    const testDirectories = fs.readdirSync(packageRoot).filter((name) => fs.existsSync(path.join(packageRoot, name, "test")));
    if (testDirectories.length) throw new Error(`Compiled test directories were included in MCPB: ${testDirectories.join(", ")}`);
    const acceptanceFiles = fs.readdirSync(path.join(packageRoot, "mcp-server", "src")).filter((name) => /Acceptance\.js$/.test(name));
    if (acceptanceFiles.length) throw new Error(`Acceptance executables were included in MCPB: ${acceptanceFiles.join(", ")}`);
    extractedSmoke = await sendMcpRequests(path.join(packageRoot, "mcp-server", "src", "server.js"));
    checks.push({ name: "mcpb_extracted_server", status: "pass", initialize: extractedSmoke.initialize, health_ok: true });
    process.stdout.write("PASS  mcpb_extracted_server\n");
    failedStage = null;

    const linuxSummary = JSON.parse(fs.readFileSync(path.join(reportDirectory, "linux", "summary.json"), "utf8"));
    const sanitizerSummary = JSON.parse(fs.readFileSync(path.join(reportDirectory, "sanitized", "summary.json"), "utf8"));
    const report = {
      schema_version: "1.0",
      version,
      platform: `${process.platform}/${process.arch}`,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      ok: true,
      checks,
      linux: linuxSummary,
      sanitizer: sanitizerSummary,
      linux_host_bundle: linuxHostBundleReport,
      extracted_mcpb: extractedSmoke,
      explicit_not_run: [
        ...(linuxSummary.coverage?.gnu_emacs_ert === "not_run" ? ["GNU Emacs ERT"] : []),
        ...(linuxSummary.coverage?.real_emacs_x11_native === "not_run" ? ["real GNU Emacs X11 native acceptance"] : []),
        "Wayland-native backend",
        "uinput backend",
        "macOS Accessibility/CGEvent/ScreenCaptureKit acceptance",
        "paid or networked LLM paired experiment"
      ]
    };
    fs.writeFileSync(path.join(reportDirectory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`PASS: Emacs Operator ${version} Linux release gate\nReport directory: ${reportDirectory}\n`);
  } catch (error) {
    const report = {
      schema_version: "1.0",
      version,
      platform: `${process.platform}/${process.arch}`,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      ok: false,
      failed_stage: failedStage,
      error: error instanceof Error ? error.message : String(error),
      checks
    };
    fs.writeFileSync(path.join(reportDirectory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    throw error;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
