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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-linux-packages-"));
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
      const clojureNs = `emacs-operator.alpha16-${nonce}`;
      const source = pkg === "cider"
        ? [`(ns ${clojureNs})`, `(defn ${fnName} [x] (+ x 1))`, `(${fnName} 41)`, `(/ 1 0)`, ""].join("\n")
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
        if (sessionId) await close(sessionId);
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
