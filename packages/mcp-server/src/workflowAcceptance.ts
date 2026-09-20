import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ToolRouter } from "./tools/toolRouter.js";
import type { ToolEnvelope } from "../../protocol/src/index.js";

interface AnyRecord { [key: string]: unknown }
type GateStatus = "pass" | "fail" | "skip" | "info";
interface Gate { name: string; status: GateStatus; details?: string; data?: Record<string, unknown> }
interface WorkflowReport {
  schema_version: "1.0";
  started_at: string;
  finished_at?: string;
  platform: string;
  node: string;
  instance_id?: string;
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
function evaluationResult(value: unknown, label: string): AnyRecord {
  const top = asRecord(value, label);
  const execution = asRecord(top.execution, `${label}.execution`);
  const evaluation = asRecord(execution.evaluation, `${label}.evaluation`);
  return asRecord(evaluation.result, `${label}.result`);
}
function validationFor(value: unknown, adapter: string): AnyRecord {
  const top = asRecord(value, "validation result");
  const validation = asRecord(top.validation, "validation bridge result");
  const validations = asRecord(validation.validations, "adapter validations");
  return asRecord(validations[adapter], `${adapter} validation`);
}

async function main(): Promise<void> {
  const report: WorkflowReport = {
    schema_version: "1.0",
    started_at: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    gates: []
  };
  const router = new ToolRouter();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-workflow-"));
  const sessions = new Set<string>();
  const runtimeSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const alpha8CalcName = `emacs-operator-alpha8-calc-${runtimeSuffix}`;
  const alpha8HelperName = `emacs-operator-alpha8-helper-${runtimeSuffix}`;
  const alpha10CalcName = `emacs-operator-alpha10-calc-${runtimeSuffix}`;
  const alpha10HelperName = `emacs-operator-alpha10-helper-${runtimeSuffix}`;

  const gate = async (name: string, fn: () => Promise<string | void>): Promise<void> => {
    try {
      const details = await fn();
      const item: Gate = { name, status: "pass", ...(details ? { details } : {}) };
      report.gates.push(item);
      process.stdout.write(`PASS  ${name}${details ? `  ${details}` : ""}\n`);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const item: Gate = { name, status: "fail", details };
      report.gates.push(item);
      process.stdout.write(`FAIL  ${name}  ${details}\n`);
      throw error;
    }
  };

  const close = async (sessionId: string): Promise<void> => {
    if (!sessions.has(sessionId)) return;
    await router.call("emacs_session_close", { session_id: sessionId });
    sessions.delete(sessionId);
  };

  let fatal: unknown;
  try {
    const instances = asRecord(unwrap(await router.call("emacs_instances", {}), "instances"), "instances result");
    const list = Array.isArray(instances.instances) ? instances.instances as AnyRecord[] : [];
    const requested = process.env.EMACS_OPERATOR_ACCEPTANCE_INSTANCE_ID;
    const live = list.filter((item) => item && item.stale !== true && item.process_alive !== false);
    const selected = requested ? live.find((item) => item.instance_id === requested) : live[0];
    if (!selected) throw new Error(requested ? `Requested instance ${requested} is unavailable.` : "No live Emacs Operator instance was discovered.");
    const instanceId = stringValue(selected.instance_id, "instance_id");
    report.instance_id = instanceId;

    const lispFile = path.join(workspace, "repair.el");
    fs.writeFileSync(lispFile, [
      ";;; repair.el --- alpha6 workflow fixture -*- lexical-binding: t; -*-",
      "",
      "(defun emacs-operator-alpha6-divide (x)",
      "  (/ 10 (- x x)))",
      "",
      "(emacs-operator-alpha6-divide 2)",
      ""
    ].join("\n"));

    let lispSession = "";
    await gate("Lisp workflow opens trusted background session", async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: lispFile, project_root: workspace },
        permission_profile: "trusted_local",
        default_channel: "semantic"
      }), "open Lisp workflow"), "open Lisp result");
      const session = asRecord(opened.session, "Lisp session");
      lispSession = stringValue(session.sessionId, "Lisp session id");
      sessions.add(lispSession);
      return `session=${lispSession}`;
    });

    await gate("Lisp validator diagnoses structural corruption and rollback restores it", async () => {
      const before = asRecord(unwrap(await router.call("emacs_read", { session_id: lispSession, max_chars: 262144 }), "read Lisp"), "Lisp read");
      const text = stringValue(before.text, "Lisp text");
      const original = "(/ 10 (- x x)))";
      const broken = "(/ 10 (- x x))";
      const index = text.indexOf(original);
      if (index < 0) throw new Error("Could not locate structural corruption target.");
      const checkpoint = asRecord(unwrap(await router.call("emacs_checkpoint", { session_id: lispSession, action: "create" }), "create structural checkpoint"), "checkpoint");
      const checkpointId = stringValue(checkpoint.checkpoint_id, "checkpoint id");
      const observed = asRecord(unwrap(await router.call("emacs_observe", { session_id: lispSession, scope: ["compact"] }), "observe Lisp"), "observe");
      const buffer = asRecord(observed.buffer, "buffer");
      unwrap(await router.call("emacs_edit", {
        session_id: lispSession,
        operation: "replace_range",
        start: index + 1,
        end: index + original.length + 1,
        text: broken,
        precondition: { expected_buffer_tick: buffer.buffer_tick }
      }), "break Lisp structure");
      const invalid = validationFor(unwrap(await router.call("emacs_validate", { session_id: lispSession, adapter: "lisp" }), "validate broken Lisp"), "lisp");
      if (invalid.valid !== false || !Array.isArray(invalid.diagnostics) || invalid.diagnostics.length === 0) {
        throw new Error("Broken Lisp did not return a repairable structural diagnostic.");
      }
      unwrap(await router.call("emacs_rollback", { session_id: lispSession, checkpoint_id: checkpointId }), "rollback structural corruption");
      const valid = validationFor(unwrap(await router.call("emacs_validate", { session_id: lispSession, adapter: "lisp" }), "validate restored Lisp"), "lisp");
      if (valid.valid !== true) throw new Error("Rollback did not restore valid Lisp structure.");
      return `diagnostic_count=${(invalid.diagnostics as unknown[]).length}`;
    });

    await gate("Lisp observe-edit-eval-repair-verify-commit loop", async () => {
      unwrap(await router.call("emacs_navigate", { session_id: lispSession, operation: "buffer_start" }), "go to Lisp buffer start");
      unwrap(await router.call("emacs_navigate", { session_id: lispSession, operation: "search_forward", query: "(defun emacs-operator-alpha6-divide" }), "find defun");
      unwrap(await router.call("emacs_navigate", { session_id: lispSession, operation: "beginning_of_defun" }), "beginning of defun");
      const defined = evaluationResult(unwrap(await router.call("emacs_eval", {
        session_id: lispSession, language: "buffer_language", operation: "eval_defun", timeout_ms: 5000
      }), "eval broken defun"), "define result");
      if (defined.completed !== true) throw new Error(`Defun definition failed: ${String(defined.stderr ?? defined.condition)}`);

      unwrap(await router.call("emacs_navigate", { session_id: lispSession, operation: "buffer_end" }), "go to failing call");
      const failed = evaluationResult(unwrap(await router.call("emacs_eval", {
        session_id: lispSession, language: "buffer_language", operation: "eval_last_sexp", timeout_ms: 5000
      }), "eval failing call"), "failing evaluation");
      if (failed.completed !== false || typeof failed.condition !== "string") {
        throw new Error("Expected the broken function to return a structured runtime condition.");
      }

      const checkpoint = asRecord(unwrap(await router.call("emacs_checkpoint", { session_id: lispSession, action: "create" }), "create repair checkpoint"), "repair checkpoint");
      const checkpointId = stringValue(checkpoint.checkpoint_id, "repair checkpoint id");
      const read = asRecord(unwrap(await router.call("emacs_read", { session_id: lispSession, max_chars: 262144 }), "read before repair"), "repair read");
      const text = stringValue(read.text, "repair text");
      const needle = "(- x x)";
      const index = text.indexOf(needle);
      if (index < 0) throw new Error("Repair expression was not found.");
      const observed = asRecord(unwrap(await router.call("emacs_observe", { session_id: lispSession, scope: ["compact"] }), "observe before repair"), "repair observe");
      const buffer = asRecord(observed.buffer, "repair buffer");
      unwrap(await router.call("emacs_edit", {
        session_id: lispSession,
        operation: "replace_range",
        start: index + 1,
        end: index + needle.length + 1,
        text: "x",
        precondition: { expected_buffer_tick: buffer.buffer_tick }
      }), "repair function body");

      const structural = validationFor(unwrap(await router.call("emacs_validate", { session_id: lispSession, adapter: "lisp" }), "validate repair"), "lisp");
      if (structural.valid !== true) {
        unwrap(await router.call("emacs_rollback", { session_id: lispSession, checkpoint_id: checkpointId }), "rollback invalid repair");
        throw new Error("Repair failed structural validation and was rolled back.");
      }

      unwrap(await router.call("emacs_navigate", { session_id: lispSession, operation: "buffer_start" }), "go to Lisp buffer start after repair");
      unwrap(await router.call("emacs_navigate", { session_id: lispSession, operation: "search_forward", query: "(defun emacs-operator-alpha6-divide" }), "find repaired defun");
      unwrap(await router.call("emacs_navigate", { session_id: lispSession, operation: "beginning_of_defun" }), "begin repaired defun");
      const redefined = evaluationResult(unwrap(await router.call("emacs_eval", {
        session_id: lispSession, language: "buffer_language", operation: "eval_defun", timeout_ms: 5000
      }), "eval repaired defun"), "redefine result");
      if (redefined.completed !== true) {
        unwrap(await router.call("emacs_rollback", { session_id: lispSession, checkpoint_id: checkpointId }), "rollback failed redefine");
        throw new Error(`Repaired defun did not evaluate: ${String(redefined.stderr ?? redefined.condition)}`);
      }
      unwrap(await router.call("emacs_navigate", { session_id: lispSession, operation: "buffer_end" }), "go to repaired call");
      const succeeded = evaluationResult(unwrap(await router.call("emacs_eval", {
        session_id: lispSession, language: "buffer_language", operation: "eval_last_sexp", timeout_ms: 5000
      }), "eval repaired call"), "repaired evaluation");
      if (succeeded.completed !== true || String(succeeded.value) !== "5") {
        unwrap(await router.call("emacs_rollback", { session_id: lispSession, checkpoint_id: checkpointId }), "rollback incorrect repair");
        throw new Error(`Expected repaired value 5, got ${String(succeeded.value)}.`);
      }
      unwrap(await router.call("emacs_checkpoint", { session_id: lispSession, action: "commit", checkpoint_id: checkpointId }), "commit repair");
      return `condition=${String(failed.condition)}, repaired_value=5`;
    });
    await close(lispSession);

    const orgFile = path.join(workspace, "build.org");
    fs.writeFileSync(orgFile, "");
    let orgSession = "";
    await gate("Org structured document build, Babel execution and validation", async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: orgFile, project_root: workspace },
        permission_profile: "trusted_local",
        default_channel: "semantic"
      }), "open Org workflow"), "open Org result");
      orgSession = stringValue(asRecord(opened.session, "Org session").sessionId, "Org session id");
      sessions.add(orgSession);
      const checkpoint = asRecord(unwrap(await router.call("emacs_checkpoint", { session_id: orgSession, action: "create" }), "create Org checkpoint"), "Org checkpoint");
      const checkpointId = stringValue(checkpoint.checkpoint_id, "Org checkpoint id");
      const command = async (name: string, args: unknown[] = []) => unwrap(await router.call("emacs_command", {
        session_id: orgSession, command: name, interactive: false, arguments: args
      }), name);
      const end = async () => unwrap(await router.call("emacs_navigate", { session_id: orgSession, operation: "buffer_end" }), "Org buffer end");

      await command("emacs-operator-org-create-heading", ["Project", 1, null, ["alpha6"]]);
      await end();
      await command("emacs-operator-org-create-heading", ["Data", 2]);
      await end();
      await command("emacs-operator-org-insert-table", [["Name", "Value"], [["A", "1"], ["B", "2"]]]);
      await command("emacs-operator-org-table-set-cell", [3, 2, "42"]);
      await end();
      await command("emacs-operator-org-create-heading", ["Computation", 2]);
      await end();
      await command("emacs-operator-org-insert-src-block", ["emacs-lisp", "(+ 40 2)", ":results value"]);

      const beforeEval = validationFor(unwrap(await router.call("emacs_validate", { session_id: orgSession, adapter: "org" }), "validate constructed Org"), "org");
      if (beforeEval.valid !== true) {
        unwrap(await router.call("emacs_rollback", { session_id: orgSession, checkpoint_id: checkpointId }), "rollback invalid Org build");
        throw new Error("Constructed Org document failed structural validation.");
      }
      const evaluated = evaluationResult(unwrap(await router.call("emacs_eval", {
        session_id: orgSession, language: "buffer_language", operation: "execute_babel", adapter: "org", timeout_ms: 5000
      }), "execute constructed Babel block"), "Org Babel result");
      if (evaluated.completed !== true || String(evaluated.value) !== "42") {
        unwrap(await router.call("emacs_rollback", { session_id: orgSession, checkpoint_id: checkpointId }), "rollback failed Org Babel");
        throw new Error(`Expected Babel value 42, got ${String(evaluated.value)}.`);
      }
      const afterEval = validationFor(unwrap(await router.call("emacs_validate", { session_id: orgSession, adapter: "org" }), "validate evaluated Org"), "org");
      if (afterEval.valid !== true) {
        unwrap(await router.call("emacs_rollback", { session_id: orgSession, checkpoint_id: checkpointId }), "rollback invalid evaluated Org");
        throw new Error("Org document became structurally invalid after Babel execution.");
      }
      const read = asRecord(unwrap(await router.call("emacs_read", { session_id: orgSession, max_chars: 262144 }), "read built Org"), "built Org read");
      const text = stringValue(read.text, "built Org text");
      for (const expected of ["* Project", "** Data", "| B", "42", "** Computation", "#+begin_src emacs-lisp", "#+RESULTS:"]) {
        if (!text.includes(expected)) {
          unwrap(await router.call("emacs_rollback", { session_id: orgSession, checkpoint_id: checkpointId }), "rollback incomplete Org build");
          throw new Error(`Built Org document is missing ${expected}.`);
        }
      }
      unwrap(await router.call("emacs_checkpoint", { session_id: orgSession, action: "commit", checkpoint_id: checkpointId }), "commit Org build");
      await close(orgSession);
      return "heading tree + table + source block + Babel result verified";
    });

    const alpha7File = path.join(workspace, "alpha7-repair.el");
    fs.writeFileSync(alpha7File, [
      ";;; alpha7-repair.el --- semantic transaction fixture -*- lexical-binding: t; -*-",
      "",
      "(defun emacs-operator-alpha7-answer (x)",
      "  (+ x 0))",
      "",
      "(emacs-operator-alpha7-answer 40)",
      ""
    ].join("\n"));
    let alpha7Session = "";
    await gate("Alpha.7 high-level Lisp semantic transaction validates, evaluates behavior, and commits", async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: alpha7File, project_root: workspace },
        permission_profile: "trusted_local", default_channel: "semantic"
      }), "open alpha7 Lisp workflow"), "alpha7 Lisp open result");
      alpha7Session = stringValue(asRecord(opened.session, "alpha7 Lisp session").sessionId, "alpha7 Lisp session id");
      sessions.add(alpha7Session);
      const read = asRecord(unwrap(await router.call("emacs_read", { session_id: alpha7Session, max_chars: 262144 }), "read alpha7 Lisp"), "alpha7 Lisp read");
      const text = stringValue(read.text, "alpha7 Lisp text");
      const needle = "(+ x 0)";
      const index = text.indexOf(needle);
      if (index < 0) throw new Error("Alpha.7 repair target was not found.");
      const result = asRecord(unwrap(await router.call("emacs_workflow", {
        session_id: alpha7Session,
        operation: "repair_lisp",
        edit: { operation: "replace_range", start: index + 1, end: index + needle.length + 1, text: "(+ x 2)" },
        evaluation: {
          steps: [
            { operation: "eval_defun", navigation: { operation: "beginning_of_defun" } },
            { operation: "eval_last_sexp", navigation: { operation: "buffer_end" }, expected_value: "42" }
          ]
        }
      }), "alpha7 repair_lisp workflow"), "alpha7 repair workflow result");
      const workflow = asRecord(result.workflow, "alpha7 repair workflow");
      if (workflow.status !== "committed") throw new Error(`Expected committed repair workflow, got ${String(workflow.status)}.`);
      const evaluations = Array.isArray(workflow.evaluations) ? workflow.evaluations as AnyRecord[] : [];
      if (evaluations.length !== 2 || String(evaluations[1]?.value) !== "42") {
        throw new Error("Alpha.7 repair workflow did not verify the expected behavior value 42.");
      }
      await close(alpha7Session);
      return "single workflow call: edit -> validate -> eval_defun -> eval call=42 -> commit";
    });

    const alpha7OrgFile = path.join(workspace, "alpha7-section.org");
    fs.writeFileSync(alpha7OrgFile, "");
    let alpha7OrgSession = "";
    await gate("Alpha.7 high-level Org section transaction builds and validates a complete section", async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: alpha7OrgFile, project_root: workspace },
        permission_profile: "trusted_local", default_channel: "semantic"
      }), "open alpha7 Org workflow"), "alpha7 Org open result");
      alpha7OrgSession = stringValue(asRecord(opened.session, "alpha7 Org session").sessionId, "alpha7 Org session id");
      sessions.add(alpha7OrgSession);
      const result = asRecord(unwrap(await router.call("emacs_workflow", {
        session_id: alpha7OrgSession,
        operation: "org_build_section",
        section: {
          title: "Alpha 7 Semantic Transaction",
          level: 1,
          tags: ["alpha7", "agent"],
          properties: { OWNER: "emacs-operator" },
          body: "This section was built as one guarded semantic transaction.",
          table: { headers: ["Metric", "Value"], rows: [["answer", "42"]] },
          source_block: { language: "emacs-lisp", body: "(+ 40 2)", headers: ":results value", execute: true, expected_value: "42" }
        },
        validate_options: { max_nodes: 100 }
      }), "alpha7 org_build_section workflow"), "alpha7 Org workflow result");
      const workflow = asRecord(result.workflow, "alpha7 Org workflow");
      if (workflow.status !== "committed") throw new Error(`Expected committed Org workflow, got ${String(workflow.status)}.`);
      const validation = asRecord(workflow.validation, "alpha7 Org validation");
      if (validation.valid !== true) throw new Error("Alpha.7 Org workflow returned invalid structure.");
      const built = asRecord(unwrap(await router.call("emacs_read", { session_id: alpha7OrgSession, max_chars: 262144 }), "read alpha7 Org"), "alpha7 Org read");
      const builtText = stringValue(built.text, "alpha7 Org text");
      for (const expected of ["* Alpha 7 Semantic Transaction", ":OWNER:", "emacs-operator", "| answer", "#+begin_src emacs-lisp", "#+RESULTS:"]) {
        if (!builtText.includes(expected)) throw new Error(`Alpha.7 Org workflow output is missing ${expected}.`);
      }
      await close(alpha7OrgSession);
      return "single workflow call: heading + properties + body + table + Babel=42 + AST validation + commit";
    });

    const alpha8RenameFile = path.join(workspace, "alpha8-rename.el");
    fs.writeFileSync(alpha8RenameFile, [
      ";;; alpha8-rename.el --- syntax-aware rename fixture -*- lexical-binding: t; -*-",
      "",
      "(defun emacs-operator-alpha8-rename (foo foo/bar)",
      "  ;; foo in this comment must remain unchanged",
      "  (list foo foo/bar \"foo\" 'foo))",
      ""
    ].join("\n"));
    let alpha8RenameSession = "";
    await gate("Alpha.8 syntax-aware symbol rename preserves comments, strings, and larger symbols", async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: alpha8RenameFile, project_root: workspace },
        permission_profile: "workspace_edit", default_channel: "semantic"
      }), "open alpha8 rename"), "alpha8 rename open");
      alpha8RenameSession = stringValue(asRecord(opened.session, "alpha8 rename session").sessionId, "alpha8 rename session id");
      sessions.add(alpha8RenameSession);
      unwrap(await router.call("emacs_navigate", { session_id: alpha8RenameSession, operation: "search_forward", query: "(list" }), "locate rename defun body");
      const result = asRecord(unwrap(await router.call("emacs_workflow", {
        session_id: alpha8RenameSession,
        operation: "rename_symbol",
        old_symbol: "foo",
        new_symbol: "qux",
        scope: "current_defun"
      }), "alpha8 rename_symbol workflow"), "alpha8 rename workflow result");
      const workflow = asRecord(result.workflow, "alpha8 rename workflow");
      if (workflow.status !== "committed") throw new Error(`Expected committed rename, got ${String(workflow.status)}.`);
      const read = asRecord(unwrap(await router.call("emacs_read", { session_id: alpha8RenameSession, max_chars: 262144 }), "read alpha8 rename"), "alpha8 rename read");
      const text = stringValue(read.text, "alpha8 rename text");
      for (const expected of ["(qux foo/bar)", ";; foo in this comment", "(list qux foo/bar \"foo\" 'qux)"]) {
        if (!text.includes(expected)) throw new Error(`Syntax-aware rename output is missing ${expected}.`);
      }
      if (text.includes("qux/bar")) throw new Error("Rename incorrectly changed a prefix inside foo/bar.");
      await close(alpha8RenameSession);
      return "current_defun rename changed code symbols only";
    });

    const alpha8ExtractFile = path.join(workspace, "alpha8-extract.el");
    fs.writeFileSync(alpha8ExtractFile, [
      ";;; alpha8-extract.el --- buffer-derived extraction fixture -*- lexical-binding: t; -*-",
      "",
      `(defun ${alpha8CalcName} (x)`,
      "  (+ x 1)",
      "  (* x 2))",
      "",
      `(${alpha8HelperName} 41)`,
      ""
    ].join("\n"));
    let alpha8ExtractSession = "";
    await gate("Alpha.8 extract_function derives the body from the buffer, loads it, and verifies behavior", async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: alpha8ExtractFile, project_root: workspace },
        permission_profile: "trusted_local", default_channel: "semantic"
      }), "open alpha8 extraction"), "alpha8 extraction open");
      alpha8ExtractSession = stringValue(asRecord(opened.session, "alpha8 extract session").sessionId, "alpha8 extract session id");
      sessions.add(alpha8ExtractSession);
      const read = asRecord(unwrap(await router.call("emacs_read", { session_id: alpha8ExtractSession, max_chars: 262144 }), "read alpha8 extraction"), "alpha8 extraction read");
      const text = stringValue(read.text, "alpha8 extraction text");
      const needle = "(+ x 1)";
      const index = text.indexOf(needle);
      if (index < 0) throw new Error("Alpha.8 extraction target was not found.");
      unwrap(await router.call("emacs_navigate", { session_id: alpha8ExtractSession, operation: "goto_position", position: index + 1 }), "position inside extraction defun");
      const collision = await router.call("emacs_workflow", {
        session_id: alpha8ExtractSession,
        operation: "extract_function",
        range: { start: index + 1, end: index + needle.length + 1 },
        name: alpha8CalcName,
        parameters: ["x"]
      });
      if (collision.ok || collision.error.code !== "E_STATE_CONFLICT") {
        throw new Error(`Expected extract_function name collision to return E_STATE_CONFLICT, got ${collision.ok ? "success" : collision.error.code}.`);
      }
      const afterCollision = stringValue(asRecord(unwrap(await router.call("emacs_read", { session_id: alpha8ExtractSession, max_chars: 262144 }), "read after extraction collision"), "read after extraction collision").text, "text after extraction collision");
      if (afterCollision !== text) throw new Error("Function-name collision changed the buffer before rejection.");

      const result = asRecord(unwrap(await router.call("emacs_workflow", {
        session_id: alpha8ExtractSession,
        operation: "extract_function",
        range: { start: index + 1, end: index + needle.length + 1 },
        name: alpha8HelperName,
        parameters: ["x"],
        evaluate_definition: true,
        evaluation: { operation: "eval_last_sexp", navigation: { operation: "buffer_end" }, expected_value: "42" }
      }), "alpha8 extract_function workflow"), "alpha8 extract workflow result");
      const workflow = asRecord(result.workflow, "alpha8 extract workflow");
      if (workflow.status !== "committed") throw new Error(`Expected committed extraction, got ${String(workflow.status)}.`);
      const transactionScope = asRecord(workflow.transaction_scope, "alpha8 extraction transaction scope");
      if (transactionScope.runtime !== "not_transactional") throw new Error("Runtime evaluation side effects were not explicitly reported as non-transactional.");
      const evaluations = Array.isArray(workflow.evaluations) ? workflow.evaluations as AnyRecord[] : [];
      if (evaluations.length !== 2 || String(evaluations[1]?.value) !== "42") {
        throw new Error("Extracted function did not produce verified value 42.");
      }
      const after = stringValue(asRecord(unwrap(await router.call("emacs_read", { session_id: alpha8ExtractSession, max_chars: 262144 }), "read extracted Lisp"), "read extracted Lisp").text, "extracted Lisp text");
      if (!after.includes(`(defun ${alpha8HelperName} (x)`)) throw new Error("New extracted definition is missing.");
      if (!after.includes(`(${alpha8HelperName} x)`)) throw new Error("Original range was not replaced by the generated call.");
      await close(alpha8ExtractSession);
      return "collision guard -> buffer-derived body -> new defun -> eval_defun -> call=42 -> commit; runtime effects explicitly non-transactional";
    });

    const alpha10ExtractFile = path.join(workspace, "alpha10-inferred-extract.el");
    fs.writeFileSync(alpha10ExtractFile, [
      ";;; alpha10-inferred-extract.el --- analysis-first extraction fixture -*- lexical-binding: t; -*-",
      "",
      `(defun ${alpha10CalcName} (x)`,
      "  (let ((y 2))",
      "    (+ x y)))",
      "",
      `(${alpha10CalcName} 40)`,
      ""
    ].join("\n"));
    let alpha10ExtractSession = "";
    await gate("Alpha.10 extract_function infers outer defun and enclosing let bindings before mutation", async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: alpha10ExtractFile, project_root: workspace },
        permission_profile: "trusted_local", default_channel: "semantic"
      }), "open alpha10 inferred extraction"), "alpha10 inferred extraction open");
      alpha10ExtractSession = stringValue(asRecord(opened.session, "alpha10 extract session").sessionId, "alpha10 extract session id");
      sessions.add(alpha10ExtractSession);
      const read = asRecord(unwrap(await router.call("emacs_read", { session_id: alpha10ExtractSession, max_chars: 262144 }), "read alpha10 extraction"), "alpha10 extraction read");
      const text = stringValue(read.text, "alpha10 extraction text");
      const needle = "(+ x y)";
      const index = text.indexOf(needle);
      if (index < 0) throw new Error("Alpha.10 extraction target was not found.");
      unwrap(await router.call("emacs_navigate", { session_id: alpha10ExtractSession, operation: "goto_position", position: index + 1 }), "position inside alpha10 extraction defun");
      const analysisResult = asRecord(unwrap(await router.call("emacs_analyze", {
        session_id: alpha10ExtractSession, adapter: "lisp", operation: "infer_extract_parameters", params: { bounds: [index + 1, index + needle.length + 1] }
      }), "alpha10 pre-extract analysis"), "alpha10 analysis top");
      const analysisPayload = asRecord(analysisResult.analysis, "alpha10 analysis payload");
      const analysis = asRecord(analysisPayload.result, "alpha10 analysis result");
      const inferred = Array.isArray(analysis.parameters) ? analysis.parameters.map(String) : [];
      const unresolved = Array.isArray(analysis.unresolved) ? analysis.unresolved.map(String) : [];
      if (JSON.stringify(inferred) !== JSON.stringify(["x", "y"]) || unresolved.length !== 0) {
        throw new Error(`Expected inferred parameters [x,y] without unresolved names, got ${JSON.stringify({ inferred, unresolved })}.`);
      }
      const result = asRecord(unwrap(await router.call("emacs_workflow", {
        session_id: alpha10ExtractSession,
        operation: "extract_function",
        range: { start: index + 1, end: index + needle.length + 1 },
        name: alpha10HelperName,
        evaluate_definition: true,
        evaluate_enclosing_definition: true,
        evaluation: { operation: "eval_last_sexp", navigation: { operation: "buffer_end" }, expected_value: "42" }
      }), "alpha10 inferred extract workflow"), "alpha10 inferred workflow result");
      const workflow = asRecord(result.workflow, "alpha10 inferred workflow");
      if (workflow.status !== "committed") throw new Error(`Expected alpha10 inferred extraction to commit, got ${String(workflow.status)}: ${JSON.stringify(workflow)}.`);
      const workflowAnalysis = asRecord(workflow.analysis, "alpha10 workflow analysis");
      if (JSON.stringify(workflowAnalysis.parameters) !== JSON.stringify(["x", "y"])) throw new Error("Workflow did not preserve inferred [x,y] parameters.");
      const after = stringValue(asRecord(unwrap(await router.call("emacs_read", { session_id: alpha10ExtractSession, max_chars: 262144 }), "read alpha10 extracted Lisp"), "alpha10 extracted read").text, "alpha10 extracted text");
      if (!after.includes(`(defun ${alpha10HelperName} (x y)`)) throw new Error("Alpha.10 inferred helper definition is missing x/y parameters.");
      if (!after.includes(`(${alpha10HelperName} x y)`)) throw new Error("Alpha.10 inferred extraction call is missing x/y arguments.");
      await close(alpha10ExtractSession);
      return "analyze [x,y] -> extract without caller parameters -> eval definition -> call=42 -> commit";
    });

    const alpha8MoveFile = path.join(workspace, "alpha8-move.el");
    fs.writeFileSync(alpha8MoveFile, "(defun alpha8-first () 1)\n\n(defun alpha8-second () 2)\n");
    let alpha8MoveSession = "";
    await gate("Alpha.8 move_form reorders complete top-level Lisp forms without text-coordinate orchestration", async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: alpha8MoveFile, project_root: workspace },
        permission_profile: "workspace_edit", default_channel: "semantic"
      }), "open alpha8 move"), "alpha8 move open");
      alpha8MoveSession = stringValue(asRecord(opened.session, "alpha8 move session").sessionId, "alpha8 move session id");
      sessions.add(alpha8MoveSession);
      unwrap(await router.call("emacs_navigate", { session_id: alpha8MoveSession, operation: "buffer_start" }), "move fixture start");
      const result = asRecord(unwrap(await router.call("emacs_workflow", {
        session_id: alpha8MoveSession, operation: "move_form", direction: "down"
      }), "alpha8 move_form workflow"), "alpha8 move workflow result");
      const workflow = asRecord(result.workflow, "alpha8 move workflow");
      if (workflow.status !== "committed") throw new Error(`Expected committed form move, got ${String(workflow.status)}.`);
      const transformed = asRecord(unwrap(await router.call("emacs_workflow", {
        session_id: alpha8MoveSession, operation: "transform_sexp", transform: "indent_defun"
      }), "alpha8 transform_sexp workflow"), "alpha8 transform workflow result");
      const transformWorkflow = asRecord(transformed.workflow, "alpha8 transform workflow");
      if (transformWorkflow.status !== "committed") throw new Error(`Expected committed structural transform, got ${String(transformWorkflow.status)}.`);
      const text = stringValue(asRecord(unwrap(await router.call("emacs_read", { session_id: alpha8MoveSession, max_chars: 262144 }), "read moved forms"), "moved form read").text, "moved form text");
      if (!text.startsWith("(defun alpha8-second () 2)\n\n(defun alpha8-first () 1)")) throw new Error("Top-level forms were not reordered as expected.");
      await close(alpha8MoveSession);
      return "top-level sexps swapped, built-in structural transform ran, and Lisp validation passed";
    });

    const alpha8OrgFile = path.join(workspace, "alpha8-rewrite.org");
    fs.writeFileSync(alpha8OrgFile, [
      "* Parent :old:",
      ":PROPERTIES:",
      ":OWNER: Kevin",
      ":END:",
      "Old body",
      "** Child",
      "Keep child",
      ""
    ].join("\n"));
    let alpha8OrgSession = "";
    await gate("Alpha.8 org_rewrite_subtree preserves metadata and child hierarchy", async () => {
      const opened = asRecord(unwrap(await router.call("emacs_session_open", {
        selector: { instance_id: instanceId, file: alpha8OrgFile, project_root: workspace },
        permission_profile: "workspace_edit", default_channel: "semantic"
      }), "open alpha8 Org rewrite"), "alpha8 Org rewrite open");
      alpha8OrgSession = stringValue(asRecord(opened.session, "alpha8 Org session").sessionId, "alpha8 Org session id");
      sessions.add(alpha8OrgSession);
      unwrap(await router.call("emacs_navigate", { session_id: alpha8OrgSession, operation: "buffer_start" }), "Org rewrite start");
      const result = asRecord(unwrap(await router.call("emacs_workflow", {
        session_id: alpha8OrgSession,
        operation: "org_rewrite_subtree",
        rewrite: { expected_title: "Parent", title: "Renamed", tags: ["alpha8", "agent"], body: "New body" },
        validate_options: { max_nodes: 100 }
      }), "alpha8 org_rewrite_subtree workflow"), "alpha8 Org rewrite result");
      const workflow = asRecord(result.workflow, "alpha8 Org rewrite workflow");
      if (workflow.status !== "committed") throw new Error(`Expected committed Org rewrite, got ${String(workflow.status)}.`);
      const text = stringValue(asRecord(unwrap(await router.call("emacs_read", { session_id: alpha8OrgSession, max_chars: 262144 }), "read rewritten Org"), "rewritten Org read").text, "rewritten Org text");
      for (const expected of ["* Renamed", ":OWNER: Kevin", "New body", "** Child", "Keep child"]) {
        if (!text.includes(expected)) throw new Error(`Rewritten Org is missing preserved/expected content: ${expected}.`);
      }
      if (text.includes("Old body")) throw new Error("Old Org section body was not replaced.");
      await close(alpha8OrgSession);
      return "title/tags/body changed; property drawer and child subtree survived";
    });
  } catch (error) {
    fatal = error;
    if (!report.gates.some((item) => item.status === "fail")) {
      report.gates.push({
        name: "workflow runtime",
        status: "fail",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  } finally {
    for (const sessionId of [...sessions]) {
      try { await close(sessionId); } catch { /* preserve original failure */ }
    }
    router.bridges.closeAll();
    router.driver.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    report.finished_at = new Date().toISOString();
    const count = (status: GateStatus) => report.gates.filter((item) => item.status === status).length;
    report.summary = { passed: count("pass"), failed: count("fail"), skipped: count("skip"), info: count("info"), ok: count("fail") === 0 && !fatal };
    const output = process.env.EMACS_OPERATOR_WORKFLOW_ACCEPTANCE_REPORT;
    if (output) {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`SUMMARY pass=${report.summary.passed} fail=${report.summary.failed} ok=${report.summary.ok}\n`);
  }
  if (fatal) throw fatal;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
