import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeEmacsBridge } from "../../test-harness/src/fakeBridge.js";
import { ToolRouter } from "../src/tools/toolRouter.js";

test("MCP ToolRouter opens session, observes, edits, runs internal keys, and rolls back", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el` },
      default_channel: "internal_keys",
      permission_profile: "workspace_edit"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;

    const observed = await router.call("emacs_observe", { session_id: sessionId });
    assert.equal(observed.ok, true);
    const tick = (observed as any).result.buffer.buffer_tick as number;

    const checkpoint = await router.call("emacs_checkpoint", { session_id: sessionId, action: "create" });
    assert.equal(checkpoint.ok, true);
    const checkpointId = (checkpoint as any).result.checkpoint_id;

    const edited = await router.call("emacs_edit", {
      session_id: sessionId,
      operation: "insert",
      position: 1,
      text: ";semantic\n",
      precondition: { expected_buffer_tick: tick }
    });
    assert.equal(edited.ok, true);
    assert.match(fake.currentText(), /semantic/);

    const afterEditTick = (edited as any).state_after.buffer_tick;
    const keyed = await router.call("emacs_key_sequence", {
      session_id: sessionId,
      channel: "internal_keys",
      steps: [{ kind: "keys", value: "C-c z" }],
      precondition: { expected_buffer_tick: afterEditTick }
    });
    assert.equal(keyed.ok, true);
    assert.match(fake.currentText(), /internal-key/);

    const capabilities = await router.call("emacs_capabilities", { session_id: sessionId, operation: "adapter_capabilities", adapter: "lisp" });
    assert.equal(capabilities.ok, true);

    const deniedEval = await router.call("emacs_eval", { session_id: sessionId, language: "buffer_language", operation: "eval_last_sexp" });
    assert.equal(deniedEval.ok, false);
    if (!deniedEval.ok) assert.equal(deniedEval.error.code, "E_POLICY_DENIED");

    const rolled = await router.call("emacs_rollback", { session_id: sessionId, checkpoint_id: checkpointId });
    assert.equal(rolled.ok, true);
    assert.equal(fake.currentText(), "(alpha beta)\n");
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("structured adapter evaluation requires trusted_local and rejects source strings", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el` },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;

    const evaluated = await router.call("emacs_eval", {
      session_id: sessionId,
      language: "buffer_language",
      operation: "eval_last_sexp"
    });
    assert.equal(evaluated.ok, true);
    if (evaluated.ok) assert.equal((evaluated.result as any).execution.evaluation.result.value, "3");

    const denied = await router.call("emacs_eval", {
      session_id: sessionId,
      language: "buffer_language",
      operation: "eval_last_sexp",
      code: "(+ 1 2)"
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "E_POLICY_DENIED");
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});


test("alpha4 structured eval routes Org Babel without accepting caller source", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el` },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;

    const babel = await router.call("emacs_eval", {
      session_id: sessionId,
      language: "buffer_language",
      operation: "execute_babel",
      adapter: "org",
      timeout_ms: 5000
    });
    assert.equal(babel.ok, true);
    if (babel.ok) {
      assert.equal((babel.result as any).execution.evaluation.adapter, "org");
      assert.equal((babel.result as any).execution.evaluation.result.value, "42");
      assert.equal((babel.result as any).execution.evaluation.result.metadata.language, "emacs-lisp");
    }

    const denied = await router.call("emacs_eval", {
      session_id: sessionId,
      language: "buffer_language",
      operation: "execute_babel",
      adapter: "org",
      code: "(+ 100 200)"
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "E_POLICY_DENIED");
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha4 semantic command can target the Lisp structural facade", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el` },
      permission_profile: "workspace_edit"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const result = await router.call("emacs_command", {
      session_id: sessionId,
      command: "emacs-operator-lisp-structural-edit",
      interactive: false,
      arguments: ["forward_sexp", 1]
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal((result.result as any).execution.command, "emacs-operator-lisp-structural-edit");
      assert.equal((result.result as any).execution.return_value.operation, "forward_sexp");
      assert.equal((result.result as any).execution.return_value.provider, "fake");
    }
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});


test("alpha5 semantic navigation and paged read work without a native window", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el` },
      permission_profile: "read_only"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;

    const first = await router.call("emacs_read", { session_id: sessionId, start: 1, end: 13, max_chars: 5 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal((first.result as any).text, "(alph");
    assert.equal((first.result as any).truncated, true);
    assert.equal((first.result as any).next_start, 6);

    const moved = await router.call("emacs_navigate", {
      session_id: sessionId,
      operation: "search_forward",
      query: "beta"
    });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;
    assert.equal((moved.result as any).execution.point_after, 12);
    assert.equal((moved.result as any).observed.cursor.point, 12);

    const tickBefore = (moved.result as any).observed.buffer.buffer_tick;
    const home = await router.call("emacs_navigate", { session_id: sessionId, operation: "buffer_start" });
    assert.equal(home.ok, true);
    if (home.ok) {
      assert.equal((home.result as any).observed.cursor.point, 1);
      assert.equal((home.result as any).observed.buffer.buffer_tick, tickBefore);
    }
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});


test("alpha6 adapter validation is read-only and returns structured diagnostics", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el` },
      permission_profile: "read_only"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const beforeTick = fake.currentTick();
    const validated = await router.call("emacs_validate", { session_id: sessionId, adapter: "lisp" });
    assert.equal(validated.ok, true);
    if (validated.ok) {
      assert.equal((validated.result as any).validation.valid, true);
      assert.equal((validated.result as any).validation.validations.lisp.balanced, true);
      assert.equal((validated.result as any).observed.buffer.buffer_tick, beforeTick);
    }
    assert.equal(fake.currentTick(), beforeTick);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});



test("alpha10 adapter analysis is read-only and returns normalized analysis data", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el` },
      permission_profile: "read_only"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const beforeTick = fake.currentTick();
    const analyzed = await router.call("emacs_analyze", {
      session_id: sessionId,
      adapter: "lisp",
      operation: "infer_extract_parameters",
      params: { bounds: [1, 4] }
    });
    assert.equal(analyzed.ok, true);
    if (analyzed.ok) {
      const payload = (analyzed.result as any).analysis;
      assert.equal(payload.operation, "infer_extract_parameters");
      assert.equal(payload.adapter, "lisp");
      assert.deepEqual(payload.result.parameters, ["x"]);
      assert.equal(payload.buffer_tick, beforeTick);
    }
    assert.equal(fake.currentTick(), beforeTick);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});



test("alpha10 project rename supports read-only plan/preview and journaled apply/rollback", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const readOnly = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "read_only"
    });
    assert.equal(readOnly.ok, true);
    if (!readOnly.ok) return;
    const readSession = (readOnly.result as any).session.sessionId as string;
    const plan = await router.call("emacs_project_rename", { session_id: readSession, action: "plan", old_symbol: "alpha", new_symbol: "gamma" });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    const planId = (plan.result as any).project_rename.plan_id as string;
    const preview = await router.call("emacs_project_rename", { session_id: readSession, action: "preview", plan_id: planId });
    assert.equal(preview.ok, true);
    assert.match(JSON.stringify((preview as any).result), /gamma/);
    const denied = await router.call("emacs_project_rename", { session_id: readSession, action: "apply", plan_id: planId });
    assert.equal(denied.ok, false);
    await router.call("emacs_session_close", { session_id: readSession });

    const editable = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "workspace_edit"
    });
    assert.equal(editable.ok, true);
    if (!editable.ok) return;
    const sessionId = (editable.result as any).session.sessionId as string;
    const plan2 = await router.call("emacs_project_rename", { session_id: sessionId, action: "plan", old_symbol: "alpha", new_symbol: "gamma" });
    assert.equal(plan2.ok, true);
    if (!plan2.ok) return;
    const planId2 = (plan2.result as any).project_rename.plan_id as string;
    const applied = await router.call("emacs_project_rename", { session_id: sessionId, action: "apply", plan_id: planId2 });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    const journalId = (applied.result as any).project_rename.journal_id as string;
    assert.match(fake.currentText(), /gamma/);
    const status = await router.call("emacs_project_rename", { session_id: sessionId, action: "status", journal_id: journalId });
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal((status.result as any).project_rename.status, "open");
    assert.equal(Array.isArray((status.result as any).project_rename.entries), true);
    const rolledBack = await router.call("emacs_project_rename", { session_id: sessionId, action: "rollback", journal_id: journalId });
    assert.equal(rolledBack.ok, true);
    assert.equal(fake.currentText(), "(alpha beta)\n");
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});



test("alpha10 verification ticket blocks unchanged reruns and allows one after source repair", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const failingSource = "(defun fake-defun (x) (/ x 0))\n";
    const seeded = await router.call("emacs_edit", { session_id: sessionId, operation: "replace_range", start: 1, end: fake.currentText().length + 1, text: failingSource });
    assert.equal(seeded.ok, true);
    const started = await router.call("emacs_verification", {
      session_id: sessionId, action: "start", adapter: "lisp", operation: "eval_defun", side_effect_risk: "low", max_attempts: 3
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const ticketId = (started.result as any).verification.ticket_id as string;
    assert.equal((started.result as any).verification.status, "failed");
    assert.equal((started.result as any).verification.attempt.condition, "arith-error");

    const unchanged = await router.call("emacs_verification", { session_id: sessionId, action: "rerun", ticket_id: ticketId });
    assert.equal(unchanged.ok, true);
    if (unchanged.ok) assert.equal((unchanged.result as any).verification.reason, "source_unchanged");

    const repairedSource = "(defun fake-defun (x) (+ x 1))\n";
    const repaired = await router.call("emacs_edit", { session_id: sessionId, operation: "replace_range", start: 1, end: fake.currentText().length + 1, text: repairedSource });
    assert.equal(repaired.ok, true);
    const rerun = await router.call("emacs_verification", { session_id: sessionId, action: "rerun", ticket_id: ticketId });
    assert.equal(rerun.ok, true);
    if (rerun.ok) {
      assert.equal((rerun.result as any).verification.status, "completed");
      assert.equal((rerun.result as any).verification.attempt_count, 2);
    }
    const closed = await router.call("emacs_verification", { session_id: sessionId, action: "close", ticket_id: ticketId });
    assert.equal(closed.ok, true);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

class FakeNativeDriver {
  sent: any[] = [];
  restored: any[] = [];

  async initialize() {
    return {
      protocol_version: "1.0", connected: true, native_keyboard: true, window_focus: true,
      window_capture: false, frontmost_query: true, accessibility_trusted: true, screen_recording_granted: false
    };
  }
  async permissions() { return [{ name: "accessibility", status: "granted", granted: true }]; }
  async frontmostApplication() { return { pid: process.pid, name: "Emacs" }; }
  async focusEmacs(target: any) { return { focused_application: target, verified_frontmost: true }; }
  async sendKeySequence(target: any, events: any[], options: any) {
    this.sent.push({ target, events, options });
    return {
      sent_events: events.length * 2,
      cancelled: false,
      user_interference_detected: false,
      restored_previous_application: false,
      previous_frontmost: { pid: 777, name: "Terminal" }
    };
  }
  async restoreApplication(application: any) { this.restored.push(application); return true; }
  async captureEmacs() { throw new Error("not implemented"); }
  async cancelAll() {}
  close() {}
}

test("native key channel maps canonical events, keeps focus through observation, and restores the prior app", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const native = new FakeNativeDriver();
  const router = new ToolRouter(native as any);
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el` },
      default_channel: "native_keys",
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;

    const executed = await router.call("emacs_key_sequence", {
      session_id: sessionId,
      channel: "native_keys",
      steps: [
        { kind: "event", event: { kind: "key_press", key: "x", modifiers: ["control"], repeat: 2, delayAfterMs: 5 } },
        { kind: "text", value: "你好" }
      ]
    });
    assert.equal(executed.ok, true);
    assert.equal(native.sent.length, 1);
    assert.equal(native.sent[0].target.pid, process.pid);
    assert.equal(native.sent[0].target.window_title, "fake.el - GNU Emacs");
    assert.equal(native.sent[0].target.window_identifier, "4242");
    assert.deepEqual(native.sent[0].events[0], {
      kind: "key_press", key: "x", modifiers: ["control"], repeat_count: 2, delay_after_milliseconds: 5
    });
    assert.deepEqual(native.sent[0].events[1], { kind: "text", text: "你好" });
    assert.equal(native.sent[0].options.restore_frontmost, false);
    assert.equal(native.restored.length, 1);
    assert.equal(native.restored[0].pid, 777);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

class FakeCaptureDriver {
  constructor(private readonly capturePath: string) {}
  async initialize() {
    return {
      protocol_version: "1.0", connected: true, native_keyboard: false, window_focus: false,
      window_capture: true, frontmost_query: true, accessibility_trusted: false, screen_recording_granted: true
    };
  }
  async permissions() { return [{ name: "screen_recording", status: "granted", granted: true }]; }
  async frontmostApplication() { return { pid: process.pid, name: "Emacs" }; }
  async focusEmacs() { throw new Error("not implemented"); }
  async sendKeySequence() { throw new Error("not implemented"); }
  async restoreApplication() { return false; }
  async captureEmacs() { return { path: this.capturePath, width: 1, height: 1 }; }
  async cancelAll() {}
  close() {}
}

test("emacs_capture requires trusted_local, consumes a private PNG, and removes the transient file", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-router-capture-"));
  const capturePath = path.join(captureRoot, "capture.png");
  const onePixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(capturePath, onePixel, { mode: 0o600 });

  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  const previousCapture = process.env.EMACS_OPERATOR_CAPTURE_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  process.env.EMACS_OPERATOR_CAPTURE_DIR = captureRoot;
  const router = new ToolRouter(new FakeCaptureDriver(capturePath) as any);
  try {
    const workspace = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el` },
      permission_profile: "workspace_edit"
    });
    assert.equal(workspace.ok, true);
    if (!workspace.ok) return;
    const denied = await router.call("emacs_capture", { session_id: (workspace.result as any).session.sessionId });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "E_POLICY_DENIED");
    await router.call("emacs_session_close", { session_id: (workspace.result as any).session.sessionId });

    const trusted = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el` },
      permission_profile: "trusted_local"
    });
    assert.equal(trusted.ok, true);
    if (!trusted.ok) return;
    const captured = await router.call("emacs_capture", { session_id: (trusted.result as any).session.sessionId });
    assert.equal(captured.ok, true);
    if (captured.ok) {
      assert.equal((captured.result as any).mime_type, "image/png");
      assert.equal(Buffer.from((captured.result as any).image_data, "base64").equals(onePixel), true);
    }
    assert.equal(fs.existsSync(capturePath), false);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    if (previousCapture === undefined) delete process.env.EMACS_OPERATOR_CAPTURE_DIR;
    else process.env.EMACS_OPERATOR_CAPTURE_DIR = previousCapture;
    fs.rmSync(captureRoot, { recursive: true, force: true });
    await fake.stop();
  }
});


test("alpha7 repair_lisp workflow commits successful validation and evaluation", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const result = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "repair_lisp",
      edit: { operation: "replace_range", start: 2, end: 7, text: "gamma" },
      evaluation: { operation: "eval_last_sexp", expected_value: "3" }
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.result as any).workflow.status, "committed");
    assert.equal((result.result as any).workflow.evaluation.value, "3");
    assert.equal(fake.currentText(), "(gamma beta)\n");
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha7 repair_lisp workflow rolls back an unexpected evaluation value", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const original = fake.currentText();
    const result = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "repair_lisp",
      edit: { operation: "insert", position: 1, text: ";candidate\n" },
      evaluation: { operation: "eval_last_sexp", expected_value: "999" }
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.result as any).workflow.status, "rolled_back");
    assert.equal((result.result as any).workflow.reason, "unexpected_value");
    assert.equal((result.result as any).workflow.transaction_scope.buffer, "checkpoint_managed");
    assert.equal((result.result as any).workflow.transaction_scope.runtime, "not_transactional");
    assert.match((result.result as any).workflow.transaction_scope.warning, /runtime side effects/i);
    assert.equal(fake.currentText(), original);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha7 refactor_defun resolves bounds from the Lisp adapter and commits atomically", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "workspace_edit"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const replacement = "(defun fake-defun () 3)\n";
    const result = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "refactor_defun",
      replacement
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.result as any).workflow.status, "committed");
    assert.equal(fake.currentText(), replacement);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha7 org_build_section composes heading, table, Babel, validation, and commit", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const orgFile = `${fake.runtimeDir}/workflow.org`;
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: orgFile, project_root: fake.runtimeDir },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const result = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "org_build_section",
      section: {
        title: "Alpha 7",
        level: 1,
        tags: ["agent"],
        body: "Semantic transaction.",
        table: { headers: ["Name", "Value"], rows: [["answer", "42"]] },
        source_block: {
          language: "emacs-lisp",
          body: "(+ 40 2)",
          headers: ":results value",
          execute: true,
          expected_value: "42"
        }
      }
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const workflow = (result.result as any).workflow;
    assert.equal(workflow.status, "committed");
    assert.equal(workflow.evaluation.value, "42");
    assert.equal(workflow.validation.valid, true);
    assert.match(fake.currentText(), /\* Alpha 7/);
    assert.match(fake.currentText(), /Semantic transaction\./);
    assert.match(fake.currentText(), /\| Name \| Value \|/);
    assert.match(fake.currentText(), /#\+begin_src emacs-lisp :results value/i);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha7 repair_lisp supports bounded multi-step evaluation inside one transaction", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const result = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "repair_lisp",
      edit: { operation: "insert", position: 1, text: ";multi-step\n" },
      evaluation: {
        steps: [
          { operation: "eval_defun" },
          { operation: "eval_last_sexp", navigation: { operation: "buffer_end" }, expected_value: "3" }
        ]
      }
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const workflow = (result.result as any).workflow;
    assert.equal(workflow.status, "committed");
    assert.equal(workflow.evaluations.length, 2);
    assert.equal(workflow.evaluations[1].value, "3");
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha7 workflow rejects unsupported evaluation operations before mutation", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const original = fake.currentText();
    const result = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "repair_lisp",
      edit: { operation: "insert", position: 1, text: ";must-not-apply\n" },
      evaluation: { operation: "eval_arbitrary_source" }
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "E_INVALID_ARGUMENT");
    assert.equal(fake.currentText(), original);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha8 rename_symbol commits a bounded semantic rename and rejects empty matches", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "workspace_edit"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const beforeIdentityMismatch = fake.currentText();
    const identityMismatch = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "rename_symbol",
      old_symbol: "alpha",
      new_symbol: "gamma",
      scope: "current_defun",
      expected_name: "not-the-current-defun"
    });
    assert.equal(identityMismatch.ok, false);
    if (identityMismatch.ok) return;
    assert.equal(identityMismatch.error.code, "E_STATE_CONFLICT");
    assert.equal(fake.currentText(), beforeIdentityMismatch);

    const renamed = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "rename_symbol",
      old_symbol: "alpha",
      new_symbol: "gamma",
      scope: "current_defun"
    });
    assert.equal(renamed.ok, true);
    if (!renamed.ok) return;
    assert.equal((renamed.result as any).workflow.status, "committed");
    assert.equal((renamed.result as any).workflow.mutation.replacements, 1);
    assert.equal(fake.currentText(), "(gamma beta)\n");

    const beforeMissing = fake.currentText();
    const missing = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "rename_symbol",
      old_symbol: "does-not-exist",
      new_symbol: "x"
    });
    assert.equal(missing.ok, true);
    if (!missing.ok) return;
    assert.equal((missing.result as any).workflow.status, "rolled_back");
    assert.equal((missing.result as any).workflow.reason, "symbol_not_found");
    assert.equal(fake.currentText(), beforeMissing);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha8 extract_function uses buffer-derived source and reports runtime evaluation as non-transactional", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const extracted = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "extract_function",
      range: { start: 2, end: 7 },
      name: "helper",
      parameters: ["x"],
      evaluate_definition: true
    });
    assert.equal(extracted.ok, true);
    if (!extracted.ok) return;
    const workflow = (extracted.result as any).workflow;
    assert.equal(workflow.status, "committed");
    assert.equal(workflow.mutation.name, "helper");
    assert.equal(workflow.evaluation.completed, true);
    assert.equal(workflow.transaction_scope.runtime, "not_transactional");
    assert.match(fake.currentText(), /^\(defun helper \(x\)/);
    assert.match(fake.currentText(), /\(helper x\)/);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha13 extract_function can explicitly load both the helper and enclosing definition", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const extracted = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "extract_function",
      range: { start: 2, end: 7 },
      name: "helper-with-enclosing",
      parameters: ["x"],
      evaluate_definition: true,
      evaluate_enclosing_definition: true
    });
    assert.equal(extracted.ok, true);
    if (!extracted.ok) return;
    const workflow = (extracted.result as any).workflow;
    assert.equal(workflow.status, "committed");
    assert.equal(workflow.evaluations.length, 2);
    assert.equal(workflow.evaluations.every((item: any) => item.completed === true), true);
  } finally {
    router.bridges.closeAll();
    router.driver.close();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha13 evaluate_enclosing_definition requires helper evaluation", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const before = fake.currentText();
    const rejected = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "extract_function",
      range: { start: 2, end: 7 },
      name: "invalid-enclosing-eval",
      parameters: ["x"],
      evaluate_enclosing_definition: true
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "E_INVALID_ARGUMENT");
    assert.equal(fake.currentText(), before);
  } finally {
    router.bridges.closeAll();
    router.driver.close();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha10 extract_function infers parameters before checkpoint when parameters are omitted", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "workspace_edit"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const extracted = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "extract_function",
      range: { start: 2, end: 7 },
      name: "auto-helper"
    });
    assert.equal(extracted.ok, true);
    if (!extracted.ok) return;
    const workflow = (extracted.result as any).workflow;
    assert.equal(workflow.status, "committed");
    assert.deepEqual(workflow.analysis.parameters, ["x"]);
    assert.deepEqual(workflow.mutation.parameters, ["x"]);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha10 extract_function refuses unresolved inferred parameters before mutation", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "workspace_edit"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    await router.call("emacs_edit", { session_id: sessionId, operation: "insert", position: 1, text: "UNRESOLVED_ANALYSIS " });
    const before = fake.currentText();
    const extracted = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "extract_function",
      range: { start: 2, end: 7 },
      name: "should-not-extract"
    });
    assert.equal(extracted.ok, false);
    if (extracted.ok) return;
    assert.equal(extracted.error.code, "E_ANALYSIS_UNRESOLVED");
    assert.deepEqual(extracted.error.details?.unresolved, ["mystery"]);
    assert.equal(fake.currentText(), before);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha10 verification ticket stops when structured evaluation target drifts", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "trusted_local"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    await router.call("emacs_edit", {
      session_id: sessionId, operation: "replace_range", start: 1, end: fake.currentText().length + 1,
      text: "(FAIL_EVAL)\n(second-expression)\n"
    });
    await router.call("emacs_navigate", { session_id: sessionId, operation: "buffer_end" });
    const started = await router.call("emacs_verification", {
      session_id: sessionId, action: "start", adapter: "lisp", operation: "eval_last_sexp", side_effect_risk: "low", max_attempts: 3
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const ticketId = (started.result as any).verification.ticket_id as string;
    assert.equal((started.result as any).verification.status, "failed");
    const previousStart = (started.result as any).verification.attempt.metadata.source_start;
    assert.equal(typeof previousStart, "number");

    await router.call("emacs_navigate", { session_id: sessionId, operation: "buffer_start" });
    const rerun = await router.call("emacs_verification", { session_id: sessionId, action: "rerun", ticket_id: ticketId });
    assert.equal(rerun.ok, true);
    if (rerun.ok) {
      assert.equal((rerun.result as any).verification.status, "stopped");
      assert.equal((rerun.result as any).verification.reason, "source_target_changed");
      assert.equal((rerun.result as any).verification.previous_source_start, previousStart);
      assert.equal((rerun.result as any).verification.current_source_start, 1);
    }
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha8 move_form and transform_sexp are guarded Lisp transactions", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/fake.el`, project_root: fake.runtimeDir },
      permission_profile: "workspace_edit"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    await router.call("emacs_edit", {
      session_id: sessionId,
      operation: "insert",
      position: fake.currentText().length + 1,
      text: "(second form)\n"
    });
    const moved = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "move_form",
      direction: "down"
    });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;
    assert.equal((moved.result as any).workflow.status, "committed");
    assert.match(fake.currentText(), /^\(second form\)/);

    const transformed = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "transform_sexp",
      transform: "indent_defun"
    });
    assert.equal(transformed.ok, true);
    if (!transformed.ok) return;
    assert.equal((transformed.result as any).workflow.status, "committed");
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha8 org_rewrite_subtree rewrites section content while preserving child hierarchy", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/rewrite.org`, project_root: fake.runtimeDir },
      permission_profile: "workspace_edit"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    await router.call("emacs_edit", {
      session_id: sessionId,
      operation: "replace_range",
      start: 1,
      end: fake.currentText().length + 1,
      text: "* Parent\nOld body\n** Child\nKeep child\n"
    });
    const rewritten = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "org_rewrite_subtree",
      rewrite: {
        expected_title: "Parent",
        title: "Renamed",
        tags: ["agent"],
        body: "New body"
      }
    });
    assert.equal(rewritten.ok, true);
    if (!rewritten.ok) return;
    assert.equal((rewritten.result as any).workflow.status, "committed");
    assert.match(fake.currentText(), /^\* Renamed :agent:/);
    assert.match(fake.currentText(), /New body/);
    assert.doesNotMatch(fake.currentText(), /Old body/);
    assert.match(fake.currentText(), /\*\* Child\nKeep child/);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha8 org_rewrite_subtree checks expected_title before any mutation", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/rewrite.org`, project_root: fake.runtimeDir },
      permission_profile: "workspace_edit"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    await router.call("emacs_edit", {
      session_id: sessionId,
      operation: "replace_range",
      start: 1,
      end: fake.currentText().length + 1,
      text: "* Actual\nBody\n"
    });
    const before = fake.currentText();
    const result = await router.call("emacs_workflow", {
      session_id: sessionId,
      operation: "org_rewrite_subtree",
      rewrite: { expected_title: "Different", body: "Must not apply" }
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "E_STATE_CONFLICT");
    assert.equal(fake.currentText(), before);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha11 project rename binds Clojure namespace semantics into the real MCP plan lifecycle", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/core.clj`, project_root: fake.runtimeDir },
      permission_profile: "read_only"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const beforeTick = fake.currentTick();

    const inferred = await router.call("emacs_project_rename", {
      session_id: sessionId,
      action: "plan",
      old_symbol: "app.calc/sum",
      new_symbol: "app.calc/add"
    });
    assert.equal(inferred.ok, true);
    if (!inferred.ok) return;
    assert.equal((inferred.result as any).project_rename.language, "clojure");
    assert.equal((inferred.result as any).project_rename.qualification_policy, "preserve_qualification");
    assert.equal((inferred.result as any).project_rename.new_symbol, "app.calc/add");

    const leafOnly = await router.call("emacs_project_rename", {
      session_id: sessionId,
      action: "plan",
      old_symbol: "app.calc/sum",
      new_symbol: "add",
      language: "clojure",
      qualification_policy: "leaf_only"
    });
    assert.equal(leafOnly.ok, true);
    if (!leafOnly.ok) return;
    const plan = (leafOnly.result as any).project_rename;
    assert.equal(plan.requested_new_symbol, "add");
    assert.equal(plan.new_symbol, "app.calc/add");
    assert.equal(plan.language, "clojure");
    assert.equal(plan.qualification_policy, "leaf_only");
    assert.equal(plan.symbol_semantics.old.qualifier, "app.calc");
    assert.equal(plan.symbol_semantics.new.qualifier, "app.calc");

    const preview = await router.call("emacs_project_rename", {
      session_id: sessionId,
      action: "preview",
      plan_id: plan.plan_id
    });
    assert.equal(preview.ok, true);
    if (preview.ok) {
      assert.equal((preview.result as any).project_rename.requested_new_symbol, "add");
      assert.equal((preview.result as any).project_rename.new_symbol, "app.calc/add");
    }
    assert.equal(fake.currentTick(), beforeTick);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});

test("alpha11 project rename preserves Common Lisp package visibility and rejects qualification drift before Bridge execution", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  try {
    const opened = await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: `${fake.runtimeDir}/core.lisp`, project_root: fake.runtimeDir },
      permission_profile: "read_only"
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const sessionId = (opened.result as any).session.sessionId as string;
    const beforeTick = fake.currentTick();

    const external = await router.call("emacs_project_rename", {
      session_id: sessionId,
      action: "plan",
      old_symbol: "APP:SUM",
      new_symbol: "add",
      language: "common_lisp",
      qualification_policy: "leaf_only"
    });
    assert.equal(external.ok, true);
    if (external.ok) {
      const plan = (external.result as any).project_rename;
      assert.equal(plan.new_symbol, "APP:add");
      assert.equal(plan.symbol_semantics.new.kind, "package_external_symbol");
      assert.equal(plan.symbol_semantics.new.separator, ":");
    }

    const internal = await router.call("emacs_project_rename", {
      session_id: sessionId,
      action: "plan",
      old_symbol: "APP::SUM",
      new_symbol: "add",
      language: "common_lisp",
      qualification_policy: "leaf_only"
    });
    assert.equal(internal.ok, true);
    if (internal.ok) {
      assert.equal((internal.result as any).project_rename.new_symbol, "APP::add");
      assert.equal((internal.result as any).project_rename.symbol_semantics.new.kind, "package_internal_symbol");
    }

    const drift = await router.call("emacs_project_rename", {
      session_id: sessionId,
      action: "plan",
      old_symbol: "app.calc/sum",
      new_symbol: "other/add",
      language: "clojure",
      qualification_policy: "preserve_qualification"
    });
    assert.equal(drift.ok, false);
    if (!drift.ok) {
      assert.equal(drift.error.code, "E_INVALID_ARGUMENT");
      assert.equal(drift.error.details?.semantic_code, "E_SYMBOL_QUALIFICATION_CHANGE");
    }

    const sameIdentity = await router.call("emacs_project_rename", {
      session_id: sessionId,
      action: "plan",
      old_symbol: "APP:SUM",
      new_symbol: "app:sum",
      language: "common_lisp",
      qualification_policy: "exact"
    });
    assert.equal(sameIdentity.ok, false);
    if (!sameIdentity.ok) {
      assert.equal(sameIdentity.error.details?.semantic_code, "E_SYMBOL_IDENTITY_UNCHANGED");
    }
    assert.equal(fake.currentTick(), beforeTick);
  } finally {
    router.bridges.closeAll();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
    await fake.stop();
  }
});
