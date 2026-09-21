#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
if (process.platform !== "linux") {
  process.stderr.write("accept:alpha16 is a Linux-first release gate.\n");
  process.exit(64);
}

const stamp = new Date().toISOString().replace(/[-:.]/g, "");
const reportDir = path.resolve(process.env.EMACS_OPERATOR_ALPHA16_REPORT_DIR ?? path.join(root, "dist", "acceptance", `alpha16-${stamp}`));
const reportPath = path.resolve(process.env.EMACS_OPERATOR_ALPHA16_REPORT ?? path.join(reportDir, "summary.json"));
fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(reportDir, 0o700); } catch {}

const requireRealEmacs = /^(1|true|yes|on)$/i.test(process.env.EMACS_OPERATOR_ALPHA16_REQUIRE_REAL_EMACS ?? "");
const runFullLinux = !/^(0|false|no|off)$/i.test(process.env.EMACS_OPERATOR_ALPHA16_RUN_LINUX ?? "1");
const reuseLinuxReportDir = process.env.EMACS_OPERATOR_ALPHA16_REUSE_LINUX_REPORT_DIR ? path.resolve(process.env.EMACS_OPERATOR_ALPHA16_REUSE_LINUX_REPORT_DIR) : null;
const gates = [];
let failedStage = null;

function run(name, command, args, { required = true, env = {}, timeout = 20 * 60_000 } = {}) {
  const logPath = path.join(reportDir, `${name}.log`);
  process.stdout.write(`RUN   ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 96 * 1024 * 1024,
    timeout
  });
  fs.writeFileSync(logPath, `${result.stdout ?? ""}${result.stderr ?? ""}`, { mode: 0o600 });
  const ok = !result.error && result.status === 0;
  const gate = {
    name,
    required,
    status: ok ? "pass" : "fail",
    exit_code: result.status,
    signal: result.signal ?? null,
    log: path.basename(logPath),
    error: result.error?.message ?? null
  };
  gates.push(gate);
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}\n`);
  if (!ok && required) throw new Error(`${name} failed (${result.error?.message ?? `exit ${String(result.status)}`}). See ${logPath}.`);
  return gate;
}

function notRun(name, reason, required = false) {
  const gate = { name, required, status: required ? "fail" : "not_run", reason };
  gates.push(gate);
  process.stdout.write(`${required ? "FAIL" : "SKIP"}  ${name}: ${reason}\n`);
  if (required) throw new Error(`${name} is required but unavailable: ${reason}`);
  return gate;
}

function validateSourceLock() {
  const lockPath = path.join(root, "scripts", "package-runtime", "sources.lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.schema_version !== "1.0" || !lock.sources || typeof lock.sources !== "object") throw new Error("Package source lock schema is invalid.");
  const expected = ["paredit", "cider", "sly"];
  for (const name of expected) {
    const item = lock.sources[name];
    if (!item || item.kind !== "git") throw new Error(`Source lock is missing ${name}.`);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(item.repository)) throw new Error(`${name} repository is not a pinned GitHub HTTPS repository.`);
    if (!/^[0-9a-f]{40}$/.test(item.commit)) throw new Error(`${name} commit must be a full 40-character lowercase SHA-1.`);
    if (!Array.isArray(item.entrypoints) || item.entrypoints.length === 0 || item.entrypoints.some((p) => typeof p !== "string" || p.startsWith("/") || p.includes(".."))) throw new Error(`${name} entrypoints are unsafe.`);
  }
  return { lockPath, sources: expected.map((name) => ({ name, commit: lock.sources[name].commit, version: lock.sources[name].version })) };
}

function detectRealEmacs() {
  const result = spawnSync("bash", ["-lc", "source scripts/resolve-emacs.sh; resolve_emacs_bin >/dev/null 2>&1; printf '%s\\n' \"${EMACS_OPERATOR_RESOLVED_EMACS:-}\""], {
    cwd: root, env: process.env, encoding: "utf8", timeout: 15_000
  });
  const binary = (result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  return result.status === 0 && binary ? binary : null;
}

const startedAt = new Date().toISOString();
let sourceLock = null;
let realEmacs = null;
try {
  failedStage = "version_consistency";
  run("version-consistency", process.execPath, ["scripts/sync-version.mjs", "--check"]);

  failedStage = "source_lock";
  sourceLock = validateSourceLock();
  gates.push({ name: "package-source-lock", required: true, status: "pass", sources: sourceLock.sources });
  process.stdout.write("PASS  package-source-lock\n");

  failedStage = "resolver_tests";
  run("resolve-emacs-tests", "bash", ["scripts/test-resolve-emacs.sh"]);

  failedStage = "runtime_provision_tests";
  run("runtime-provision-tests", process.execPath, ["--test", "scripts/runtime/provision-emacs-runtime.test.mjs"]);

  failedStage = "source_acquisition_tests";
  run("source-acquisition-tests", process.execPath, ["--test", "scripts/package-runtime/acquire-git-source.test.mjs"]);

  failedStage = "shell_syntax";
  run("shell-syntax", "bash", ["-lc", "set -e; while IFS= read -r -d '' f; do bash -n \"$f\"; done < <(find scripts -type f -name '*.sh' -print0)"]);

  failedStage = "elisp_structure";
  run("elisp-structure", "python3", ["scripts/check-elisp-structure.py"]);

  failedStage = "typescript_typecheck";
  run("typescript-typecheck", "npm", ["run", "typecheck"]);

  failedStage = "typescript_tests";
  run("typescript-tests", "npm", ["run", "test:ts"], { timeout: 30 * 60_000 });

  failedStage = "agent_experiment_tests";
  run("agent-experiment-tests", "npm", ["run", "test:agent-experiment"]);

  failedStage = "linux_host_tests";
  run("linux-host-tests", "npm", ["run", "linux-host:test"]);

  failedStage = "real_emacs_ert";
  realEmacs = detectRealEmacs();
  if (realEmacs) {
    run("real-emacs-ert", "npm", ["run", "test:elisp"], { env: { EMACS_OPERATOR_EMACS_BIN: realEmacs }, timeout: 20 * 60_000 });
  } else {
    notRun("real-emacs-ert", "No GNU Emacs 29+ executable is available. Use scripts/runtime/provision-emacs-runtime.mjs to provision a private runtime from locked local .deb files.", requireRealEmacs);
  }

  if (reuseLinuxReportDir) {
    failedStage = "linux_reused_evidence";
    const summaryPath = path.join(reuseLinuxReportDir, "summary.json");
    if (!fs.existsSync(summaryPath)) throw new Error(`Reused Linux evidence has no summary.json: ${summaryPath}`);
    const linuxSummary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    if (linuxSummary?.schema_version !== "1.0" || linuxSummary?.platform !== "linux" || linuxSummary?.result !== "pass" || linuxSummary?.exit_code !== 0) {
      throw new Error(`Reused Linux evidence is not a passing Linux acceptance summary: ${summaryPath}`);
    }
    if (linuxSummary?.coverage?.x11_xtest_synthetic_target !== "pass" || linuxSummary?.coverage?.x11_reliability !== "pass" || linuxSummary?.coverage?.installed_linux_host !== "pass") {
      throw new Error(`Reused Linux evidence is missing required X11/native/install coverage: ${summaryPath}`);
    }
    gates.push({ name: "linux-full-acceptance", required: true, status: "pass", reused: true, summary: summaryPath, coverage: linuxSummary.coverage });
    process.stdout.write(`PASS  linux-full-acceptance (reused ${summaryPath})\n`);
  } else if (runFullLinux) {
    failedStage = "linux_full_acceptance";
    run("linux-full-acceptance", "bash", ["scripts/accept-linux.sh"], {
      env: {
        EMACS_OPERATOR_LINUX_ACCEPTANCE_REPORT_DIR: path.join(reportDir, "linux"),
        ...(realEmacs ? { EMACS_OPERATOR_EMACS_BIN: realEmacs } : {})
      },
      timeout: 45 * 60_000
    });
  } else {
    notRun("linux-full-acceptance", "Disabled by EMACS_OPERATOR_ALPHA16_RUN_LINUX=0.");
  }

  failedStage = null;
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
    require_real_emacs: requireRealEmacs,
    real_emacs: realEmacs,
    source_lock: sourceLock,
    gates
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stderr.write(`FAIL alpha16: ${report.error}\nReport: ${reportPath}\n`);
  process.exitCode = 1;
  process.exit();
}

const requiredFailures = gates.filter((g) => g.required && g.status !== "pass");
const report = {
  schema_version: "1.0",
  version,
  platform: `${process.platform}/${process.arch}`,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  ok: requiredFailures.length === 0,
  require_real_emacs: requireRealEmacs,
  real_emacs: realEmacs,
  source_lock: sourceLock,
  gates,
  summary: {
    pass: gates.filter((g) => g.status === "pass").length,
    fail: gates.filter((g) => g.status === "fail").length,
    not_run: gates.filter((g) => g.status === "not_run").length,
    required_failures: requiredFailures.map((g) => g.name)
  }
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`PASS alpha16 portable/Linux gate: ${version}\nReport: ${reportPath}\n`);
