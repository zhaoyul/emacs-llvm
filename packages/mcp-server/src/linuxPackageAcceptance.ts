import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ToolRouter } from "./tools/toolRouter.js";
import type { ToolEnvelope } from "../../protocol/src/index.js";

type GateStatus = "pass" | "fail" | "not_run" | "info";
type AnyRecord = Record<string, unknown>;

interface Gate {
  name: string;
  package: "paredit" | "cider" | "sly" | "infrastructure";
  status: GateStatus;
  details?: string;
  data?: Record<string, unknown>;
}

interface PackageReport {
  schema_version: "1.0";
  started_at: string;
  finished_at?: string;
  platform: string;
  node: string;
  instance_id?: string;
  requirements: { paredit: boolean; cider: boolean; sly: boolean };
  gates: Gate[];
  packages: Record<string, { status: GateStatus; reason?: string }>;
  summary?: { passed: number; failed: number; not_run: number; info: number; ok: boolean };
}

function asRecord(value: unknown, label: string): AnyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object.`);
  return value as AnyRecord;
}

function unwrap<T = unknown>(envelope: ToolEnvelope<T>, label: string): T {
  if (!envelope.ok) throw new Error(`${label}: ${envelope.error.code}: ${envelope.error.message}`);
  return envelope.result;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing.`);
  return value;
}

function envBool(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

function boundedWaitMs(): number {
  const raw = Number(process.env.EMACS_OPERATOR_LINUX_PACKAGE_WAIT_MS ?? "5000");
  if (!Number.isFinite(raw)) return 5000;
  return Math.min(60000, Math.max(0, Math.floor(raw)));
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function evaluationResult(value: unknown, label: string): AnyRecord {
  const top = asRecord(value, label);
  const execution = asRecord(top.execution, `${label}.execution`);
  const evaluation = asRecord(execution.evaluation, `${label}.evaluation`);
  return asRecord(evaluation.result, `${label}.result`);
}

function adapterState(value: unknown, adapter: string): AnyRecord | null {
  const top = asRecord(value, "adapter observe");
  const adapters = asRecord(top.adapters, "adapter observe.adapters");
  const state = adapters[adapter];
  return state && typeof state === "object" && !Array.isArray(state) ? state as AnyRecord : null;
}

async function readText(router: ToolRouter, sessionId: string): Promise<string> {
  const read = asRecord(unwrap(await router.call("emacs_read", { session_id: sessionId, max_chars: 262144 }), "emacs_read"), "read");
  return stringValue(read.text, "buffer text");
}

async function featureLoaded(router: ToolRouter, sessionId: string, feature: string): Promise<boolean> {
  const result = asRecord(unwrap(await router.call("emacs_capabilities", {
    session_id: sessionId, operation: "check_feature", feature
  }), `check feature ${feature}`), `feature ${feature}`);
  return result.loaded === true;
}


function readJsonFile(file: string, label: string): AnyRecord {
  if (!fs.existsSync(file)) throw new Error(`${label} does not exist: ${file}`);
  return asRecord(JSON.parse(fs.readFileSync(file, "utf8")), label);
}

function packageRuntimeManifest(): AnyRecord | null {
  const manifestPath = process.env.EMACS_OPERATOR_LINUX_PACKAGE_RUNTIME_MANIFEST;
  if (!manifestPath) return null;
  const manifest = readJsonFile(manifestPath, "package runtime manifest");
  if (manifest.schema_version !== "1.0" || typeof manifest.plan_sha256 !== "string") {
    throw new Error("Package runtime manifest has invalid schema/provenance metadata.");
  }
  const expectedPlan = process.env.EMACS_OPERATOR_LINUX_PACKAGE_RUNTIME_PLAN_SHA256;
  if (expectedPlan && manifest.plan_sha256 !== expectedPlan) {
    throw new Error(`Package runtime plan SHA mismatch: expected ${expectedPlan}, got ${String(manifest.plan_sha256)}.`);
  }
  return manifest;
}

function packageSourceRoot(manifest: AnyRecord | null, name: "paredit" | "cider" | "sly"): string | null {
  if (!manifest) return null;
  const packages = asRecord(manifest.packages, "package runtime manifest.packages");
  const pkg = asRecord(packages[name], `package runtime package ${name}`);
  const sourceRoot = stringValue(pkg.source_root, `${name} source_root`);
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) throw new Error(`${name} locked source_root is unavailable: ${sourceRoot}`);
  return fs.realpathSync(sourceRoot);
}

async function symbolSource(router: ToolRouter, sessionId: string, command: string): Promise<string> {
  const result = asRecord(unwrap(await router.call("emacs_capabilities", {
    session_id: sessionId, operation: "symbol_source", command
  }), `symbol source ${command}`), `symbol source ${command}`);
  const source = stringValue(result.source, `${command} source`);
  if (!fs.existsSync(source)) throw new Error(`${command} source path does not exist: ${source}`);
  return fs.realpathSync(source);
}

function assertSourceWithin(source: string, root: string | null, label: string): void {
  if (!root) throw new Error(`${label} cannot pass without a locked package runtime manifest/source_root.`);
  const relative = path.relative(root, source);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} loaded from ${source}, outside locked source root ${root}.`);
}

function verifyFileListManifest(root: string, manifest: AnyRecord, label: string): { files: number } {
  const rawFiles = manifest.files;
  if (!Array.isArray(rawFiles)) throw new Error(`${label} manifest has no file list.`);
  const files: unknown[] = rawFiles;
  const locked = new Map<string, { bytes: number; sha256: string }>();
  for (const raw of files) {
    const item = asRecord(raw, `${label} file entry`);
    const rel = stringValue(item.path, `${label} file path`);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error(`${label} manifest has unsafe path: ${rel}`);
    if (typeof item.bytes !== "number" || typeof item.sha256 !== "string") throw new Error(`${label} manifest has invalid metadata for ${rel}.`);
    if (locked.has(rel)) throw new Error(`${label} manifest has duplicate file path: ${rel}`);
    locked.set(rel, { bytes: item.bytes, sha256: item.sha256 });
  }
  for (const [rel, meta] of locked) {
    const file = path.join(root, rel);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} file is not a regular file: ${rel}`);
    if (stat.size !== meta.bytes) throw new Error(`${label} size mismatch: ${rel}`);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (digest !== meta.sha256) throw new Error(`${label} SHA-256 mismatch: ${rel}`);
  }
  return { files: locked.size };
}

function sbclProvenance(): { version: string; plan_sha256: string; manifest: string; files: number } | null {
  const manifestPath = process.env.EMACS_OPERATOR_LINUX_SBCL_RUNTIME_MANIFEST;
  if (!manifestPath) return null;
  const root = path.dirname(path.resolve(manifestPath));
  const manifest = readJsonFile(manifestPath, "SBCL runtime manifest");
  if (manifest.schema_version !== "1.0" || manifest.runtime !== "sbcl") throw new Error("Invalid SBCL runtime manifest.");
  const version = stringValue(manifest.version, "SBCL version");
  const planSha = stringValue(manifest.plan_sha256, "SBCL plan SHA");
  const expected = process.env.EMACS_OPERATOR_LINUX_SBCL_RUNTIME_PLAN_SHA256;
  if (expected && planSha !== expected) throw new Error(`SBCL plan SHA mismatch: expected ${expected}, got ${planSha}.`);
  const verified = verifyFileListManifest(root, manifest, "SBCL runtime");
  return { version, plan_sha256: planSha, manifest: path.resolve(manifestPath), files: verified.files };
}

function ciderJvmProvenance(): { plan_sha256: string; manifest: string; files: number; versions: AnyRecord } | null {
  const manifestPath = process.env.EMACS_OPERATOR_LINUX_CIDER_JVM_RUNTIME_MANIFEST;
  if (!manifestPath) return null;
  const root = path.dirname(path.resolve(manifestPath));
  const manifest = readJsonFile(manifestPath, "CIDER JVM runtime manifest");
  if (manifest.schema_version !== "1.0" || manifest.runtime !== "cider-jvm") throw new Error("Invalid CIDER JVM runtime manifest.");
  const planSha = stringValue(manifest.plan_sha256, "CIDER JVM plan SHA");
  const expected = process.env.EMACS_OPERATOR_LINUX_CIDER_JVM_RUNTIME_PLAN_SHA256;
  if (expected && planSha !== expected) throw new Error(`CIDER JVM plan SHA mismatch: expected ${expected}, got ${planSha}.`);
  const jarDir = path.join(root, "jars");
  const jarsRaw = manifest.jars;
  if (!Array.isArray(jarsRaw)) throw new Error("CIDER JVM runtime manifest has no jars list.");
  const synthetic: AnyRecord = { files: jarsRaw.map((raw) => {
    const jar = asRecord(raw, "CIDER JVM jar");
    return { path: `jars/${stringValue(jar.name, "CIDER JVM jar name")}`, bytes: jar.bytes, sha256: jar.sha256 };
  }) };
  if (!fs.existsSync(jarDir)) throw new Error(`CIDER JVM jar directory is missing: ${jarDir}`);
  const verified = verifyFileListManifest(root, synthetic, "CIDER JVM runtime");
  const versions = asRecord(manifest.versions, "CIDER JVM versions");
  return { plan_sha256: planSha, manifest: path.resolve(manifestPath), files: verified.files, versions };
}

async function main(): Promise<void> {
  const requirements = {
    paredit: envBool("EMACS_OPERATOR_LINUX_REQUIRE_PAREDIT"),
    cider: envBool("EMACS_OPERATOR_LINUX_REQUIRE_CIDER"),
    sly: envBool("EMACS_OPERATOR_LINUX_REQUIRE_SLY")
  };
  const report: PackageReport = {
    schema_version: "1.0",
    started_at: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    requirements,
    gates: [],
    packages: {
      paredit: { status: "not_run", reason: "not evaluated" },
      cider: { status: "not_run", reason: "not evaluated" },
      sly: { status: "not_run", reason: "not evaluated" }
    }
  };
  const reportPath = process.env.EMACS_OPERATOR_LINUX_PACKAGE_ACCEPTANCE_REPORT
    ?? path.join(process.cwd(), "dist", "acceptance", "linux-packages.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const runtimeWorkspace = path.join(process.cwd(), ".runtime");
  fs.mkdirSync(runtimeWorkspace, { recursive: true, mode: 0o700 });
  const workspace = fs.mkdtempSync(path.join(runtimeWorkspace, "package-acceptance-"));
  const router = new ToolRouter();
  const sessions = new Set<string>();
  let fatal = false;

  const add = (gate: Gate): void => {
    report.gates.push(gate);
    process.stdout.write(`${gate.status.toUpperCase().padEnd(7)} ${gate.name}${gate.details ? `  ${gate.details}` : ""}\n`);
  };

  const close = async (sessionId: string): Promise<void> => {
    if (!sessions.has(sessionId)) return;
    await router.call("emacs_session_close", { session_id: sessionId });
    sessions.delete(sessionId);
  };

  const markNotRun = (pkg: "paredit" | "cider" | "sly", reason: string): void => {
    report.packages[pkg] = { status: "not_run", reason };
    add({ name: `${pkg} runtime acceptance`, package: pkg, status: "not_run", details: reason });
    if (requirements[pkg]) {
      report.packages[pkg] = { status: "fail", reason: `required but unavailable: ${reason}` };
      add({ name: `${pkg} required policy`, package: pkg, status: "fail", details: `Required package/runtime is unavailable: ${reason}` });
      fatal = true;
    }
  };

  try {
    if (process.platform !== "linux") throw new Error("linuxPackageAcceptance must run on Linux.");
    const instances = asRecord(unwrap(await router.call("emacs_instances", {}), "emacs_instances"), "instances");
    const candidates = Array.isArray(instances.instances) ? instances.instances as AnyRecord[] : [];
    const requested = process.env.EMACS_OPERATOR_LINUX_PACKAGE_INSTANCE_ID ?? process.env.EMACS_OPERATOR_ACCEPTANCE_INSTANCE_ID;
    const live = candidates.filter((item) => item.stale !== true && item.process_alive !== false && item.system_type === "gnu/linux");
    const selected = requested ? live.find((item) => item.instance_id === requested) : live[0];
    if (!selected) throw new Error(requested ? `Requested GNU/Linux Emacs instance ${requested} is unavailable.` : "No live GNU/Linux Emacs Operator instance was discovered.");
    const instanceId = stringValue(selected.instance_id, "instance_id");
    report.instance_id = instanceId;
    add({ name: "live GNU Emacs package target", package: "infrastructure", status: "pass", details: `instance=${instanceId}` });
    const lockedRuntime = packageRuntimeManifest();
    if (lockedRuntime) add({ name: "locked package runtime manifest", package: "infrastructure", status: "pass", details: `plan_sha256=${String(lockedRuntime.plan_sha256)}` });

    // Paredit: exercise the package through its active keymap, not by direct function invocation.
    const pareditFile = path.join(workspace, "paredit.el");
    fs.writeFileSync(pareditFile, "(foo (bar baz) quux)\n");
    let pareditSession = "";
    try {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: pareditFile, project_root: workspace },
        permission_profile: "trusted_local", default_channel: "internal_keys"
      }), "open paredit fixture"), "paredit open");
      pareditSession = stringValue(asRecord(opened.session, "paredit session").sessionId, "paredit session id");
      sessions.add(pareditSession);

      // Calling the autoloaded minor-mode command is allowed. Missing command means the package is absent.
      const enabled = await router.call("emacs_command", {
        session_id: pareditSession, command: "paredit-mode", interactive: true
      });
      if (!enabled.ok) {
        if (enabled.error.code === "E_COMMAND_NOT_FOUND") markNotRun("paredit", "paredit-mode is not installed or autoloaded in this Emacs instance");
        else throw new Error(`paredit-mode failed: ${enabled.error.code}: ${enabled.error.message}`);
      } else {
        if (!(await featureLoaded(router, pareditSession, "paredit"))) throw new Error("paredit-mode executed but feature 'paredit' is not loaded.");
        const pareditSource = await symbolSource(router, pareditSession, "paredit-forward-slurp-sexp");
        const pareditRoot = packageSourceRoot(lockedRuntime, "paredit");
        assertSourceWithin(pareditSource, pareditRoot, "Paredit command provenance");
        add({ name: "paredit locked command provenance", package: "paredit", status: "pass", details: pareditSource, data: { source: pareditSource, source_root: pareditRoot ?? undefined } });
        const text = await readText(router, pareditSession);
        const baz = text.indexOf("baz");
        if (baz < 0) throw new Error("Paredit fixture is missing baz.");
        unwrap(await router.call("emacs_navigate", { session_id: pareditSession, operation: "goto_position", position: baz + 1 }), "position paredit point");
        const keyInfo = asRecord(unwrap(await router.call("emacs_capabilities", {
          session_id: pareditSession, operation: "where_is_command", command: "paredit-forward-slurp-sexp"
        }), "resolve paredit slurp key"), "paredit key info");
        const key = typeof keyInfo.key === "string" && keyInfo.key ? keyInfo.key : null;
        if (!key) throw new Error("paredit-forward-slurp-sexp has no active key binding after enabling paredit-mode.");
        const keyed = asRecord(unwrap(await router.call("emacs_key_sequence", {
          session_id: pareditSession, channel: "internal_keys",
          steps: [{ kind: "keys", value: key }],
          verify: { expected_command: "paredit-forward-slurp-sexp", check_parens: true }
        }), "paredit internal slurp"), "paredit key result");
        const execution = asRecord(keyed.execution, "paredit key execution");
        if (execution.executed !== true) throw new Error("Paredit internal key did not execute.");
        const after = await readText(router, pareditSession);
        if (!after.includes("(foo (bar baz quux))")) throw new Error(`Paredit slurp produced unexpected buffer: ${JSON.stringify(after)}`);
        report.packages.paredit = { status: "pass" };
        add({ name: "paredit runtime acceptance", package: "paredit", status: "pass", details: `${key} -> paredit-forward-slurp-sexp -> balanced structural edit` });
      }
    } finally {
      if (pareditSession) await close(pareditSession);
    }

    const runReplPackage = async (pkg: "cider" | "sly"): Promise<void> => {
      const ext = pkg === "cider" ? ".clj" : ".lisp";
      // Package acceptance may be rerun against a long-lived REPL. Give every run
      // a fresh symbol identity so an earlier successful definition cannot make a
      // later run pass accidentally or trigger a false name-collision failure.
      const nonce = crypto.randomBytes(4).toString("hex");
      const fnName = `emacs-operator-alpha16-add-${nonce}`;
      const source = pkg === "cider"
        ? ["(ns user)", `(defn ${fnName} [x] (+ x 1))`, `(${fnName} 41)`, `(/ 1 0)`, ""].join("\n")
        : [`(in-package #:cl-user)`, `(defun ${fnName} (x) (+ x 1))`, `(${fnName} 41)`, `(/ 1 0)`, ""].join("\n");
      const file = path.join(workspace, `${pkg}${ext}`);
      fs.writeFileSync(file, source);
      let sessionId = "";
      try {
        const opened = asRecord(unwrap(await router.call("emacs_session_open", {
          selector: { instance_id: instanceId, file, project_root: workspace },
          permission_profile: "trusted_local", default_channel: "semantic"
        }), `open ${pkg} fixture`), `${pkg} open`);
        sessionId = stringValue(asRecord(opened.session, `${pkg} session`).sessionId, `${pkg} session id`);
        sessions.add(sessionId);

        if (!(await featureLoaded(router, sessionId, pkg))) {
          markNotRun(pkg, `${pkg} feature is not loaded in the target Emacs instance`);
          return;
        }
        const provenanceCommand = pkg === "cider" ? "cider-connect-clj" : "sly-connect";
        const source = await symbolSource(router, sessionId, provenanceCommand);
        const sourceRoot = packageSourceRoot(lockedRuntime, pkg);
        assertSourceWithin(source, sourceRoot, `${pkg.toUpperCase()} command provenance`);
        add({ name: `${pkg} locked command provenance`, package: pkg, status: "pass", details: source, data: { command: provenanceCommand, source, source_root: sourceRoot ?? undefined } });
        if (pkg === "cider") {
          const jvm = ciderJvmProvenance();
          if (!jvm) throw new Error("CIDER runtime cannot pass without EMACS_OPERATOR_LINUX_CIDER_JVM_RUNTIME_MANIFEST.");
          add({ name: "CIDER locked JVM provenance", package: "cider", status: "pass", details: `plan_sha256=${jvm.plan_sha256}`, data: { manifest: jvm.manifest, files: jvm.files, versions: jvm.versions } });
        } else {
          const sbcl = sbclProvenance();
          if (!sbcl) throw new Error("SLY runtime cannot pass without EMACS_OPERATOR_LINUX_SBCL_RUNTIME_MANIFEST.");
          add({ name: "SLY locked SBCL provenance", package: "sly", status: "pass", details: `SBCL ${sbcl.version} plan_sha256=${sbcl.plan_sha256}`, data: sbcl });
        }
        const connectCommand = pkg === "cider" ? "emacs-operator-ci-connect-cider" : "emacs-operator-ci-connect-sly";
        unwrap(await router.call("emacs_command", {
          session_id: sessionId, command: connectCommand, interactive: true
        }), `${pkg} explicit runtime connection`);
        add({ name: `${pkg} explicit runtime connection request`, package: pkg, status: "pass", details: connectCommand });

        const deadline = Date.now() + boundedWaitMs();
        let state: AnyRecord | null = null;
        do {
          const observed = unwrap(await router.call("emacs_capabilities", { session_id: sessionId, operation: "adapter_observe" }), `${pkg} adapter observe`);
          state = adapterState(observed, pkg);
          if (state?.prompt_ready === true) break;
          if (Date.now() >= deadline) break;
          await sleep(250);
        } while (true);
        if (!state) {
          markNotRun(pkg, `${pkg} is loaded but its adapter is not applicable to ${String(asRecord(opened.target, `${pkg} target`).major_mode ?? "this buffer")}`);
          return;
        }
        if (state.prompt_ready !== true) {
          markNotRun(pkg, typeof state.ready_reason === "string" && state.ready_reason ? state.ready_reason : `${pkg} has no ready runtime connection after bounded wait`);
          return;
        }

        unwrap(await router.call("emacs_navigate", { session_id: sessionId, operation: "search_forward", query: pkg === "cider" ? `(defn ${fnName}` : `(defun ${fnName}` }), `${pkg} find definition`);
        unwrap(await router.call("emacs_navigate", { session_id: sessionId, operation: "beginning_of_defun" }), `${pkg} beginning of definition`);
        const defined = evaluationResult(unwrap(await router.call("emacs_eval", {
          session_id: sessionId, language: "repl", adapter: pkg, operation: "eval_defun", timeout_ms: 10000
        }), `${pkg} eval definition`), `${pkg} definition evaluation`);
        if (defined.completed !== true) throw new Error(`${pkg} definition evaluation failed: ${String(defined.condition ?? defined.stderr)}`);

        unwrap(await router.call("emacs_navigate", { session_id: sessionId, operation: "search_forward", query: `(${fnName} 41)` }), `${pkg} find behavior call`);
        const behavior = evaluationResult(unwrap(await router.call("emacs_eval", {
          session_id: sessionId, language: "repl", adapter: pkg, operation: "eval_last_sexp", timeout_ms: 10000
        }), `${pkg} behavior eval`), `${pkg} behavior evaluation`);
        if (behavior.completed !== true || String(behavior.value).trim() !== "42") throw new Error(`${pkg} expected value 42, got ${String(behavior.value)} (${String(behavior.condition ?? "no condition")}).`);

        unwrap(await router.call("emacs_navigate", { session_id: sessionId, operation: "search_forward", query: "(/ 1 0)" }), `${pkg} find failing form`);
        const started = asRecord(unwrap(await router.call("emacs_verification", {
          session_id: sessionId, action: "start", adapter: pkg, operation: "eval_last_sexp",
          timeout_ms: 10000, max_attempts: 2, side_effect_risk: "low"
        }), `${pkg} start verification`), `${pkg} verification start`);
        const verification = asRecord(started.verification, `${pkg} verification`);
        if (verification.status !== "failed") throw new Error(`${pkg} expected an initial structured failure, got ${String(verification.status)}.`);
        const ticketId = stringValue(verification.ticket_id, `${pkg} verification ticket`);

        const current = await readText(router, sessionId);
        const failing = "(/ 1 0)";
        const replacement = "(+ 40 2)";
        const start = current.indexOf(failing);
        if (start < 0) throw new Error(`${pkg} failing expression is missing before repair.`);
        unwrap(await router.call("emacs_edit", {
          session_id: sessionId, operation: "replace_range", start: start + 1, end: start + failing.length + 1, text: replacement
        }), `${pkg} repair failing form`);
        unwrap(await router.call("emacs_navigate", { session_id: sessionId, operation: "goto_position", position: start + replacement.length + 1 }), `${pkg} return to repaired source target`);
        const rerun = asRecord(unwrap(await router.call("emacs_verification", {
          session_id: sessionId, action: "rerun", ticket_id: ticketId
        }), `${pkg} rerun verification`), `${pkg} verification rerun`);
        const rerunState = asRecord(rerun.verification, `${pkg} rerun state`);
        if (rerunState.status !== "completed") throw new Error(`${pkg} repair rerun did not complete: ${JSON.stringify(rerunState)}.`);
        const attempt = asRecord(rerunState.attempt, `${pkg} rerun attempt`);
        if (String(attempt.value).trim() !== "42") throw new Error(`${pkg} repaired verification expected value 42, got ${String(attempt.value)}.`);
        await router.call("emacs_verification", { session_id: sessionId, action: "close", ticket_id: ticketId });

        report.packages[pkg] = { status: "pass" };
        add({ name: `${pkg} runtime acceptance`, package: pkg, status: "pass", details: `definition -> value=42 -> structured failure -> source repair -> guarded rerun=42` });
      } finally {
        if (sessionId) {
          const disconnectCommand = pkg === "cider" ? "emacs-operator-ci-disconnect-cider" : "emacs-operator-ci-disconnect-sly";
          try {
            await router.call("emacs_command", { session_id: sessionId, command: disconnectCommand, interactive: true });
          } catch { /* best effort; accept-linux.sh still owns bounded process teardown */ }
          await close(sessionId);
        }
      }
    };

    await runReplPackage("cider");
    await runReplPackage("sly");
  } catch (error) {
    fatal = true;
    add({ name: "package acceptance infrastructure", package: "infrastructure", status: "fail", details: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const sessionId of [...sessions]) {
      try { await close(sessionId); } catch { /* best effort */ }
    }
    router.bridges.closeAll();
    router.driver.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    report.finished_at = new Date().toISOString();
    const passed = report.gates.filter((g) => g.status === "pass").length;
    const failed = report.gates.filter((g) => g.status === "fail").length;
    const notRun = report.gates.filter((g) => g.status === "not_run").length;
    const info = report.gates.filter((g) => g.status === "info").length;
    report.summary = { passed, failed, not_run: notRun, info, ok: !fatal && failed === 0 };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`SUMMARY pass=${passed} fail=${failed} not_run=${notRun} info=${info} ok=${report.summary.ok}\n`);
  }
  if (!report.summary?.ok) process.exitCode = 1;
}

void main();
