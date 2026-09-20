import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRouter } from "./tools/toolRouter.js";
import type { ToolEnvelope } from "../../protocol/src/index.js";

interface AnyRecord { [key: string]: unknown }
type GateStatus = "pass" | "fail" | "skip" | "info";

interface Gate {
  name: string;
  status: GateStatus;
  details?: string;
  data?: Record<string, unknown>;
}

interface AcceptanceReport {
  schema_version: "1.0";
  started_at: string;
  finished_at?: string;
  platform: string;
  node: string;
  instance_id?: string;
  emacs_version?: string;
  gates: Gate[];
  summary?: { passed: number; failed: number; skipped: number; info: number; ok: boolean };
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

function logGate(gate: Gate): void {
  const tag = gate.status.toUpperCase().padEnd(4);
  process.stdout.write(`${tag}  ${gate.name}${gate.details ? `  ${gate.details}` : ""}\n`);
}

async function main(): Promise<void> {
  const report: AcceptanceReport = {
    schema_version: "1.0",
    started_at: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    gates: []
  };
  const router = new ToolRouter();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-acceptance-"));
  const sessions = new Set<string>();

  const gate = async (name: string, required: boolean, fn: () => Promise<string | void>): Promise<boolean> => {
    try {
      const details = await fn();
      const item: Gate = { name, status: "pass", ...(details ? { details } : {}) };
      report.gates.push(item); logGate(item); return true;
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const item: Gate = { name, status: required ? "fail" : "skip", details };
      report.gates.push(item); logGate(item); return false;
    }
  };

  const info = (name: string, details: string, data?: Record<string, unknown>): void => {
    const item: Gate = { name, status: "info", details, ...(data ? { data } : {}) };
    report.gates.push(item); logGate(item);
  };

  const closeSession = async (sessionId: string): Promise<void> => {
    if (!sessions.has(sessionId)) return;
    await router.call("emacs_session_close", { session_id: sessionId });
    sessions.delete(sessionId);
  };

  let fatalError: unknown;
  try {
    const instancesEnvelope = await router.call("emacs_instances", {});
    const instancesResult = asRecord(unwrap(instancesEnvelope, "emacs_instances"), "emacs_instances.result");
    const instances = Array.isArray(instancesResult.instances) ? instancesResult.instances : [];
    const requested = process.env.EMACS_OPERATOR_ACCEPTANCE_INSTANCE_ID;
    const live = instances.filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as AnyRecord;
      return item.stale !== true && item.process_alive !== false;
    }) as AnyRecord[];
    const selected = requested ? live.find((entry) => entry.instance_id === requested) : live[0];
    if (!selected) throw new Error(requested ? `Requested Emacs instance ${requested} is unavailable.` : "No live Emacs Operator bridge instance was discovered.");
    const instanceId = stringValue(selected.instance_id, "instance_id");
    report.instance_id = instanceId;
    if (typeof selected.emacs_version === "string") report.emacs_version = selected.emacs_version;
    info("runtime discovery", `${instanceId}, Emacs ${String(selected.emacs_version ?? "unknown")}`);

    const elispFile = path.join(workspace, "acceptance.el");
    fs.writeFileSync(elispFile, [
      ";;; acceptance.el --- Emacs Operator runtime acceptance -*- lexical-binding: t; -*-",
      "",
      "(defun emacs-operator-acceptance-double (x)",
      "  (* 2 x))",
      "",
      "(+ 40 2)",
      ""
    ].join("\n"));

    let elispSession = "";
    await gate("background Elisp session", true, async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: elispFile, project_root: workspace },
        permission_profile: "trusted_local",
        default_channel: "semantic"
      }), "open Elisp session"), "open Elisp result");
      const session = asRecord(opened.session, "Elisp session");
      elispSession = stringValue(session.sessionId, "Elisp session id"); sessions.add(elispSession);
      const target = asRecord(opened.target, "Elisp target");
      if (target.major_mode !== "emacs-lisp-mode") throw new Error(`Expected emacs-lisp-mode, got ${String(target.major_mode)}.`);
      return `session=${elispSession}`;
    });

    if (elispSession) {
      await gate("exact paged buffer read", true, async () => {
        const result = asRecord(unwrap(await router.call("emacs_read", { session_id: elispSession, start: 1, max_chars: 48 }), "emacs_read"), "read result");
        if (typeof result.text !== "string" || !result.text.startsWith(";;; acceptance.el")) throw new Error("Paged read returned unexpected text.");
        if (result.truncated !== true) throw new Error("Small page should report truncated=true.");
        if (typeof result.next_start !== "number") throw new Error("Paged read did not return next_start.");
        return `first page ${String(result.text).length} chars, next=${result.next_start}`;
      });

      await gate("semantic Lisp navigation", true, async () => {
        const moved = asRecord(unwrap(await router.call("emacs_navigate", { session_id: elispSession, operation: "search_forward", query: "(+ 40 2)" }), "search expression"), "navigation result");
        const observed = asRecord(moved.observed, "navigation observed");
        const cursor = asRecord(observed.cursor, "cursor");
        if (typeof cursor.point !== "number" || cursor.point <= 1) throw new Error("Point did not move to the expression.");
        return `point=${cursor.point}`;
      });

      await gate("buffer-derived Elisp evaluation", true, async () => {
        unwrap(await router.call("emacs_navigate", { session_id: elispSession, operation: "buffer_end" }), "navigate buffer end");
        const evaluated = asRecord(unwrap(await router.call("emacs_eval", {
          session_id: elispSession, language: "buffer_language", operation: "eval_last_sexp", timeout_ms: 5000
        }), "eval last sexp"), "eval result");
        const execution = asRecord(evaluated.execution, "eval execution");
        const evaluation = asRecord(execution.evaluation, "evaluation");
        const result = asRecord(evaluation.result, "evaluation result");
        if (String(result.value) !== "42" || result.completed !== true) throw new Error(`Expected completed value 42, got ${String(result.value)}.`);
        return "value=42";
      });

      await gate("Lisp adapter validation", true, async () => {
        const validated = asRecord(unwrap(await router.call("emacs_validate", { session_id: elispSession, adapter: "lisp" }), "validate Lisp"), "Lisp validation result");
        const validation = asRecord(validated.validation, "Lisp validation bridge result");
        const validations = asRecord(validation.validations, "Lisp validations");
        const lisp = asRecord(validations.lisp, "Lisp validation");
        if (lisp.valid !== true || lisp.balanced !== true) throw new Error("Lisp adapter validation did not report a balanced buffer.");
        return "valid=true, balanced=true";
      });

      await gate("checkpoint edit rollback", true, async () => {
        const checkpoint = asRecord(unwrap(await router.call("emacs_checkpoint", { session_id: elispSession, action: "create" }), "checkpoint create"), "checkpoint");
        const checkpointId = stringValue(checkpoint.checkpoint_id, "checkpoint id");
        const observed = asRecord(unwrap(await router.call("emacs_observe", { session_id: elispSession, scope: ["compact"] }), "observe before edit"), "observe");
        const buffer = asRecord(observed.buffer, "buffer");
        const tick = buffer.buffer_tick;
        unwrap(await router.call("emacs_edit", {
          session_id: elispSession, operation: "insert", position: 1, text: ";alpha5-checkpoint\n",
          precondition: { expected_buffer_tick: tick }
        }), "insert checkpoint marker");
        const edited = asRecord(unwrap(await router.call("emacs_read", { session_id: elispSession, start: 1, max_chars: 64 }), "read edited"), "read edited result");
        if (!String(edited.text).includes("alpha5-checkpoint")) throw new Error("Semantic edit did not appear in buffer.");
        unwrap(await router.call("emacs_rollback", { session_id: elispSession, checkpoint_id: checkpointId }), "rollback");
        const rolled = asRecord(unwrap(await router.call("emacs_read", { session_id: elispSession, start: 1, max_chars: 64 }), "read rolled back"), "read rolled result");
        if (String(rolled.text).includes("alpha5-checkpoint")) throw new Error("Rollback left the marker in the buffer.");
        return "mutation reverted atomically";
      });

      const paredit = await router.call("emacs_capabilities", { session_id: elispSession, operation: "check_feature", feature: "paredit" });
      if (paredit.ok && asRecord(paredit.result, "paredit capability").loaded === true) {
        info("paredit probe", "feature loaded; structural facade can select paredit dynamically");
      } else {
        info("paredit probe", "not loaded in this Emacs instance; builtin structural navigation still available");
      }
      await closeSession(elispSession);
    }

    const repairFile = path.join(workspace, "repair.el");
    fs.writeFileSync(repairFile, [
      ";;; repair.el --- task-level repair scenario -*- lexical-binding: t; -*-",
      "",
      "(defun emacs-operator-acceptance-next (x)",
      "  (/ x 0))",
      "",
      "(emacs-operator-acceptance-next 41)",
      ""
    ].join("\n"));

    let repairSession = "";
    await gate("Lisp repair scenario session", true, async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: repairFile, project_root: workspace },
        permission_profile: "trusted_local", default_channel: "semantic"
      }), "open repair session"), "repair open result");
      const session = asRecord(opened.session, "repair session");
      repairSession = stringValue(session.sessionId, "repair session id"); sessions.add(repairSession);
      return `session=${repairSession}`;
    });

    if (repairSession) {
      await gate("Lisp runtime condition -> repair -> verify -> commit", true, async () => {
        unwrap(await router.call("emacs_navigate", { session_id: repairSession, operation: "search_forward", query: "(/ x 0)" }), "find broken function body");
        const defined = asRecord(unwrap(await router.call("emacs_eval", {
          session_id: repairSession, language: "buffer_language", operation: "eval_defun", timeout_ms: 5000
        }), "eval broken defun"), "defined result");
        const definedResult = asRecord(asRecord(asRecord(defined.execution, "defined execution").evaluation, "defined evaluation").result, "defined adapter result");
        if (definedResult.completed !== true) throw new Error(`Broken function should define successfully, got ${String(definedResult.stderr ?? definedResult.condition)}.`);

        unwrap(await router.call("emacs_navigate", { session_id: repairSession, operation: "buffer_end" }), "navigate to broken call");
        const failed = asRecord(unwrap(await router.call("emacs_eval", {
          session_id: repairSession, language: "buffer_language", operation: "eval_last_sexp", timeout_ms: 5000
        }), "evaluate broken call"), "failed eval result");
        const failureResult = asRecord(asRecord(asRecord(failed.execution, "failed execution").evaluation, "failed evaluation").result, "failure adapter result");
        if (failureResult.completed !== false) throw new Error("Expected the runtime error to be returned as completed=false data.");
        if (typeof failureResult.condition !== "string" || typeof failureResult.stderr !== "string") throw new Error("Runtime diagnostic is missing condition/stderr.");
        const metadata = asRecord(failureResult.metadata, "failure metadata");
        if (!Array.isArray(metadata.source_bounds) || typeof metadata.source_sha256 !== "string" || typeof metadata.source_start !== "number") throw new Error("Runtime diagnostic is missing buffer-derived source metadata and locator.");

        const checkpoint = asRecord(unwrap(await router.call("emacs_checkpoint", { session_id: repairSession, action: "create" }), "repair checkpoint"), "repair checkpoint result");
        const checkpointId = stringValue(checkpoint.checkpoint_id, "repair checkpoint id");
        const full = asRecord(unwrap(await router.call("emacs_read", { session_id: repairSession, start: 1, max_chars: 4096 }), "read repair source"), "repair source");
        const text = stringValue(full.text, "repair source text");
        const needle = "(/ x 0)";
        const index = text.indexOf(needle);
        if (index < 0) throw new Error("Broken expression was not found in the buffer.");
        const start = index + 1;
        const end = start + needle.length;
        const observed = asRecord(unwrap(await router.call("emacs_observe", { session_id: repairSession, scope: ["compact"] }), "observe repair"), "repair observation");
        const buffer = asRecord(observed.buffer, "repair buffer");
        unwrap(await router.call("emacs_edit", {
          session_id: repairSession, operation: "replace_range", start, end, text: "(+ x 1)",
          precondition: { expected_buffer_tick: buffer.buffer_tick }
        }), "repair function body");

        const validated = asRecord(unwrap(await router.call("emacs_validate", { session_id: repairSession, adapter: "lisp" }), "validate repaired Lisp"), "repair validation");
        const validation = asRecord(validated.validation, "repair validation result");
        const validations = asRecord(validation.validations, "repair validations");
        const lisp = asRecord(validations.lisp, "repair Lisp validation");
        if (lisp.valid !== true || lisp.balanced !== true) throw new Error("Repaired Lisp buffer failed structural validation.");

        unwrap(await router.call("emacs_navigate", { session_id: repairSession, operation: "search_backward", query: "(+ x 1)" }), "return to repaired defun");
        const redefined = asRecord(unwrap(await router.call("emacs_eval", {
          session_id: repairSession, language: "buffer_language", operation: "eval_defun", timeout_ms: 5000
        }), "eval repaired defun"), "redefined result");
        const redefineResult = asRecord(asRecord(asRecord(redefined.execution, "redefined execution").evaluation, "redefined evaluation").result, "redefined adapter result");
        if (redefineResult.completed !== true) throw new Error(`Repaired defun evaluation failed: ${String(redefineResult.stderr ?? redefineResult.condition)}.`);

        unwrap(await router.call("emacs_navigate", { session_id: repairSession, operation: "buffer_end" }), "navigate to repaired call");
        const verified = asRecord(unwrap(await router.call("emacs_eval", {
          session_id: repairSession, language: "buffer_language", operation: "eval_last_sexp", timeout_ms: 5000
        }), "verify repaired call"), "verified eval result");
        const verifiedResult = asRecord(asRecord(asRecord(verified.execution, "verified execution").evaluation, "verified evaluation").result, "verified adapter result");
        if (verifiedResult.completed !== true || String(verifiedResult.value) !== "42") throw new Error(`Expected repaired call value 42, got ${String(verifiedResult.value)}.`);
        unwrap(await router.call("emacs_checkpoint", { session_id: repairSession, action: "commit", checkpoint_id: checkpointId }), "commit repair checkpoint");
        return `condition=${String(failureResult.condition)} -> repaired value=42`;
      });
      await closeSession(repairSession);
    }

    const orgFile = path.join(workspace, "acceptance.org");
    fs.writeFileSync(orgFile, [
      "* Table fixture", "", "| Name | Value |", "|------+-------|", "| A    |     1 |", "| B    |     2 |", "", "* Babel fixture", "",
      "#+begin_src emacs-lisp :results value", "(+ 40 2)", "#+end_src", ""
    ].join("\n"));

    let orgSession = "";
    await gate("background Org session", true, async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: orgFile, project_root: workspace }, permission_profile: "trusted_local"
      }), "open Org session"), "open Org result");
      const session = asRecord(opened.session, "Org session");
      orgSession = stringValue(session.sessionId, "Org session id"); sessions.add(orgSession);
      const target = asRecord(opened.target, "Org target");
      if (target.major_mode !== "org-mode") throw new Error(`Expected org-mode, got ${String(target.major_mode)}.`);
      return `session=${orgSession}`;
    });

    if (orgSession) {
      await gate("Org table structured edit", true, async () => {
        unwrap(await router.call("emacs_navigate", { session_id: orgSession, operation: "buffer_start" }), "Org buffer start");
        unwrap(await router.call("emacs_navigate", { session_id: orgSession, operation: "search_forward", query: "| A" }), "find Org table");
        const observed = asRecord(unwrap(await router.call("emacs_capabilities", { session_id: orgSession, operation: "adapter_observe" }), "observe Org adapter"), "adapter observe");
        const adapters = asRecord(observed.adapters, "adapters");
        const org = asRecord(adapters.org, "org adapter");
        if (!org.table) throw new Error("Org adapter did not detect the current table.");
        unwrap(await router.call("emacs_command", {
          session_id: orgSession, command: "emacs-operator-org-table-set-cell", interactive: false, arguments: [2, 2, "42"]
        }), "set Org table cell");
        const text = asRecord(unwrap(await router.call("emacs_read", { session_id: orgSession, start: 1, max_chars: 512 }), "read Org table"), "Org read");
        if (!String(text.text).includes("42")) throw new Error("Structured Org table edit was not visible.");
        return "table cell updated and realigned";
      });

      await gate("Org Babel buffer-derived evaluation", true, async () => {
        unwrap(await router.call("emacs_navigate", { session_id: orgSession, operation: "search_forward", query: "(+ 40 2)" }), "find Babel body");
        const evaluated = asRecord(unwrap(await router.call("emacs_eval", {
          session_id: orgSession, language: "buffer_language", operation: "execute_babel", adapter: "org", timeout_ms: 5000
        }), "execute Babel"), "Babel result");
        const execution = asRecord(evaluated.execution, "Babel execution");
        const evaluation = asRecord(execution.evaluation, "Babel evaluation");
        const result = asRecord(evaluation.result, "Babel adapter result");
        if (String(result.value) !== "42" || result.completed !== true) throw new Error(`Expected Babel value 42, got ${String(result.value)}.`);
        const full = asRecord(unwrap(await router.call("emacs_read", { session_id: orgSession, start: 1, max_chars: 4096 }), "read Babel results"), "Babel read");
        if (!String(full.text).includes("#+RESULTS:")) throw new Error("Org Babel did not insert a result block.");
        return "value=42 and #+RESULTS inserted";
      });
      await gate("Org adapter validation", true, async () => {
        const validated = asRecord(unwrap(await router.call("emacs_validate", { session_id: orgSession, adapter: "org" }), "validate Org"), "Org validation result");
        const validation = asRecord(validated.validation, "Org validation bridge result");
        const validations = asRecord(validation.validations, "Org validations");
        const org = asRecord(validations.org, "Org validation");
        if (org.valid !== true || org.parse_valid !== true) throw new Error("Org adapter validation did not report a valid document.");
        return "valid=true, parse_valid=true";
      });
      await closeSession(orgSession);
    }

    const authorFile = path.join(workspace, "authoring.org");
    fs.writeFileSync(authorFile, "");
    let authorSession = "";
    await gate("structured Org authoring scenario session", true, async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: authorFile, project_root: workspace },
        permission_profile: "trusted_local", default_channel: "semantic"
      }), "open authoring session"), "authoring open result");
      const session = asRecord(opened.session, "authoring session");
      authorSession = stringValue(session.sessionId, "authoring session id"); sessions.add(authorSession);
      return `session=${authorSession}`;
    });

    if (authorSession) {
      await gate("Org heading/table/Babel build -> AST validate", true, async () => {
        const heading = asRecord(unwrap(await router.call("emacs_command", {
          session_id: authorSession, command: "emacs-operator-org-create-heading", interactive: false, arguments: ["Project", 1]
        }), "create Project heading"), "Project heading result");
        const headingExecution = asRecord(heading.execution, "Project heading execution");
        if (!headingExecution.return_value || typeof headingExecution.return_value !== "object") throw new Error("Safe noninteractive command did not expose its JSON-friendly return_value.");

        unwrap(await router.call("emacs_navigate", { session_id: authorSession, operation: "buffer_end" }), "authoring end 1");
        unwrap(await router.call("emacs_command", {
          session_id: authorSession, command: "emacs-operator-org-create-heading", interactive: false, arguments: ["Data", 2]
        }), "create Data heading");
        unwrap(await router.call("emacs_navigate", { session_id: authorSession, operation: "buffer_end" }), "authoring end 2");
        unwrap(await router.call("emacs_command", {
          session_id: authorSession, command: "emacs-operator-org-insert-table", interactive: false,
          arguments: [["Name", "Value"], [["A", "1"], ["B", "2"]]]
        }), "insert Org table");
        unwrap(await router.call("emacs_command", {
          session_id: authorSession, command: "emacs-operator-org-table-set-cell", interactive: false, arguments: [3, 2, "42"]
        }), "update authored Org table");
        unwrap(await router.call("emacs_navigate", { session_id: authorSession, operation: "buffer_end" }), "authoring end 3");
        unwrap(await router.call("emacs_command", {
          session_id: authorSession, command: "emacs-operator-org-create-heading", interactive: false, arguments: ["Computation", 2]
        }), "create Computation heading");
        unwrap(await router.call("emacs_navigate", { session_id: authorSession, operation: "buffer_end" }), "authoring end 4");
        unwrap(await router.call("emacs_command", {
          session_id: authorSession, command: "emacs-operator-org-insert-src-block", interactive: false,
          arguments: ["emacs-lisp", "(+ 40 2)", ":results value"]
        }), "insert Babel block");

        const evaluated = asRecord(unwrap(await router.call("emacs_eval", {
          session_id: authorSession, language: "buffer_language", operation: "execute_babel", adapter: "org", timeout_ms: 5000
        }), "execute authored Babel"), "authored Babel result");
        const result = asRecord(asRecord(asRecord(evaluated.execution, "authored execution").evaluation, "authored evaluation").result, "authored result");
        if (result.completed !== true || String(result.value) !== "42") throw new Error(`Authored Babel block returned ${String(result.value)}.`);

        const validated = asRecord(unwrap(await router.call("emacs_validate", {
          session_id: authorSession, adapter: "org", options: { max_nodes: 50 }
        }), "validate authored Org"), "authored validation");
        const validation = asRecord(validated.validation, "authored validation bridge result");
        const validations = asRecord(validation.validations, "authored validations");
        const org = asRecord(validations.org, "authored Org validation");
        if (org.valid !== true || org.parse_valid !== true) throw new Error("Authored Org document failed structural validation.");
        const summary = asRecord(org.document_summary, "Org document summary");
        const counts = asRecord(summary.counts, "Org document counts");
        if (counts.headings !== 3 || counts.tables !== 1 || counts.src_blocks !== 1) {
          throw new Error(`Unexpected Org AST counts: ${JSON.stringify(counts)}.`);
        }
        const headings = Array.isArray(summary.headings) ? summary.headings : [];
        const titles = headings.map((entry) => entry && typeof entry === "object" ? String((entry as AnyRecord).title ?? "") : "");
        if (titles.join("/") !== "Project/Data/Computation") throw new Error(`Unexpected authored heading sequence: ${titles.join("/")}.`);
        return "3 headings, 1 table, 1 Babel block, value=42";
      });
      await closeSession(authorSession);
    }

    await gate("selected-window default target", true, async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId }, permission_profile: "workspace_edit", default_channel: "internal_keys"
      }), "open visible session"), "visible session result");
      const session = asRecord(opened.session, "visible session");
      const sessionId = stringValue(session.sessionId, "visible session id"); sessions.add(sessionId);
      const target = asRecord(opened.target, "visible target");
      if (typeof target.window_id !== "string" || target.window_id.length === 0) throw new Error("Default selector did not resolve a live selected window.");
      const capability = asRecord(unwrap(await router.call("emacs_capabilities", { session_id: sessionId, operation: "resolve_key", key: "C-a" }), "resolve C-a"), "C-a capability");
      const command = stringValue(capability.command, "C-a command");
      const keyed = asRecord(unwrap(await router.call("emacs_key_sequence", {
        session_id: sessionId, channel: "internal_keys", steps: [{ kind: "keys", value: "C-a" }], verify: { expected_command: command }
      }), "internal C-a"), "internal key result");
      const execution = asRecord(keyed.execution, "internal key execution");
      if (execution.executed !== true) throw new Error("Internal key sequence did not execute.");
      await closeSession(sessionId);
      return `window=${String(target.window_id)}, C-a -> ${command}`;
    });

    // Optional runtime probes. These are informative unless the user's Emacs is
    // already configured with the relevant REPL package and a live connection.
    for (const feature of ["cider", "sly"]) {
      info(`${feature.toUpperCase()} probe`, "runtime acceptance is conditional on the user's package being loaded and connected; use adapter_observe in the relevant source buffer for connection diagnostics");
    }
  } catch (error) {
    fatalError = error;
    const details = error instanceof Error ? error.message : String(error);
    const item: Gate = { name: "acceptance runtime", status: "fail", details };
    report.gates.push(item);
    logGate(item);
  } finally {
    for (const sessionId of [...sessions]) {
      try { await closeSession(sessionId); } catch { /* best-effort cleanup */ }
    }
    router.bridges.closeAll();
    router.driver.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    report.finished_at = new Date().toISOString();
    const passed = report.gates.filter((g) => g.status === "pass").length;
    const failed = report.gates.filter((g) => g.status === "fail").length;
    const skipped = report.gates.filter((g) => g.status === "skip").length;
    const infos = report.gates.filter((g) => g.status === "info").length;
    report.summary = { passed, failed, skipped, info: infos, ok: failed === 0 };
    const reportPath = process.env.EMACS_OPERATOR_ACCEPTANCE_REPORT;
    if (reportPath) {
      fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`INFO  report  ${path.resolve(reportPath)}\n`);
    }
  }

  if (fatalError || (report.summary && !report.summary.ok)) process.exitCode = 1;
  else process.stdout.write(`PASS  Emacs runtime acceptance  ${report.summary?.passed ?? 0} required gates passed\n`);
}

main().catch((error) => {
  process.stderr.write(`FAIL  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
