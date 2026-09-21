import fs from "node:fs";
import path from "node:path";
import { ToolRouter } from "./tools/toolRouter.js";
import type { ToolEnvelope } from "../../protocol/src/index.js";

interface AnyRecord { [key: string]: unknown }

interface NativeGate { name: string; status: "pass" | "info" | "fail"; details?: string }
const nativeReport = {
  schema_version: "1.0",
  started_at: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}`,
  node: process.version,
  gates: [] as NativeGate[]
};

function writeNativeReport(ok: boolean, error?: unknown): void {
  if (error) nativeReport.gates.push({ name: "native acceptance", status: "fail", details: error instanceof Error ? error.message : String(error) });
  const report = {
    ...nativeReport,
    finished_at: new Date().toISOString(),
    summary: {
      passed: nativeReport.gates.filter((gate) => gate.status === "pass").length,
      failed: nativeReport.gates.filter((gate) => gate.status === "fail").length,
      info: nativeReport.gates.filter((gate) => gate.status === "info").length,
      ok
    }
  };
  const destination = process.env.EMACS_OPERATOR_NATIVE_ACCEPTANCE_REPORT;
  if (destination) {
    const full = path.resolve(destination);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`INFO  report  ${full}\n`);
  }
}

function record(value: unknown, label: string): AnyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  return value as AnyRecord;
}

function unwrap(envelope: ToolEnvelope<unknown>, label: string): AnyRecord {
  if (!envelope.ok) {
    throw new Error(`${label} failed: ${envelope.error.code}: ${envelope.error.message}`);
  }
  return record(envelope.result, `${label}.result`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing.`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is missing.`);
  return value;
}

function logPass(name: string, details?: string): void {
  nativeReport.gates.push({ name, status: "pass", ...(details ? { details } : {}) });
  process.stdout.write(`PASS  ${name}${details ? `  ${details}` : ""}\n`);
}

function logInfo(message: string): void {
  nativeReport.gates.push({ name: "info", status: "info", details: message });
  process.stdout.write(`INFO  ${message}\n`);
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("macOS native acceptance must run on macOS.");
  }

  const router = new ToolRouter();
  let sessionId: string | undefined;
  try {
    const health = unwrap(await router.call("emacs_health", {}), "emacs_health");
    const nativeDriver = record(health.native_driver, "emacs_health.native_driver");
    if (nativeDriver.connected !== true) throw new Error("Emacs Operator Host is not connected.");
    if (nativeDriver.native_keyboard !== true) throw new Error("Host does not advertise native keyboard injection.");
    if (nativeDriver.window_focus !== true) throw new Error("Host does not advertise window focus.");
    if (nativeDriver.window_capture !== true) throw new Error("Host does not advertise window capture.");
    if (nativeDriver.accessibility_trusted !== true) throw new Error("Accessibility permission is not granted.");
    if (nativeDriver.screen_recording_granted !== true) throw new Error("Screen Recording permission is not granted.");
    logPass("host capabilities", "keyboard + focus + capture permissions ready");

    const instancesResult = unwrap(await router.call("emacs_instances", {}), "emacs_instances");
    const instances = Array.isArray(instancesResult.instances) ? instancesResult.instances : [];
    const requestedInstance = process.env.EMACS_OPERATOR_ACCEPTANCE_INSTANCE_ID;
    const live = instances.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as AnyRecord;
      return candidate.stale !== true && candidate.process_alive !== false;
    }) as AnyRecord[];
    const selected = requestedInstance
      ? live.find((item) => item.instance_id === requestedInstance)
      : live.find((item) => typeof item.gui_frame_count === "number" ? item.gui_frame_count > 0 : true);
    if (!selected) {
      throw new Error(requestedInstance
        ? `Requested Emacs instance ${requestedInstance} is not live.`
        : "No live graphical Emacs Operator bridge instance was discovered.");
    }
    const instanceId = requiredString(selected.instance_id, "instance_id");
    const emacsPid = requiredNumber(selected.pid, "instance pid");
    logPass("Emacs discovery", `${instanceId}, pid=${emacsPid}`);

    const beforeApp = await router.driver.frontmostApplication();
    logInfo(`frontmost before test: ${beforeApp.name ?? "unknown"} pid=${beforeApp.pid}`);

    const opened = unwrap(await router.call("emacs_session_open", {
      selector: { instance_id: instanceId },
      permission_profile: "trusted_local",
      default_channel: "semantic"
    }), "emacs_session_open");
    const session = record(opened.session, "session");
    sessionId = requiredString(session.sessionId, "session.sessionId");
    const target = record(opened.target, "target");
    logPass("session open", `buffer=${String(target.buffer_name ?? target.buffer_id ?? "unknown")}`);

    const capability = unwrap(await router.call("emacs_capabilities", {
      session_id: sessionId,
      operation: "resolve_key",
      key: "C-a"
    }), "resolve C-a");
    if (capability.bound !== true) throw new Error("C-a is not bound in the current Emacs target.");
    const expectedCommand = requiredString(capability.command, "resolved C-a command");
    logPass("key resolution", `C-a -> ${expectedCommand}`);

    const native = unwrap(await router.call("emacs_key_sequence", {
      session_id: sessionId,
      channel: "native_keys",
      steps: [{
        kind: "event",
        event: { kind: "key_press", key: "a", modifiers: ["control"] }
      }],
      verify: { expected_command: expectedCommand },
      restore_frontmost: true
    }), "native C-a");
    const verification = record(native.verification, "native verification");
    if (verification.matched !== true) throw new Error("Native key postcondition did not match.");
    logPass("native keyboard", `observed command=${String(verification.observed_command ?? expectedCommand)}`);

    const afterApp = await router.driver.frontmostApplication();
    if (beforeApp.pid !== emacsPid && afterApp.pid !== beforeApp.pid) {
      throw new Error(`Frontmost restoration failed. Before pid=${beforeApp.pid}, after pid=${afterApp.pid}.`);
    }
    if (beforeApp.pid === emacsPid) {
      logInfo("Emacs was already frontmost, so cross-application restoration was not exercised.");
    } else {
      logPass("frontmost restoration", `restored pid=${afterApp.pid}`);
    }

    const capture = unwrap(await router.call("emacs_capture", {
      session_id: sessionId,
      max_width: 1280,
      include_cursor: false
    }), "emacs_capture");
    if (capture.mime_type !== "image/png") throw new Error(`Unexpected capture MIME type: ${String(capture.mime_type)}`);
    if (capture.transient_file_consumed !== true) throw new Error("Transient capture was not consumed and cleaned up.");
    const bytes = requiredNumber(capture.bytes, "capture bytes");
    const width = requiredNumber(capture.width, "capture width");
    const height = requiredNumber(capture.height, "capture height");
    if (bytes <= 8 || width <= 0 || height <= 0) throw new Error("Captured PNG is empty.");
    logPass("window capture", `${width}x${height}, ${bytes} bytes, transient file consumed`);

    logPass("macOS native acceptance", "all automated gates passed");
  } finally {
    if (sessionId) {
      const closed = await router.call("emacs_session_close", { session_id: sessionId });
      if (closed.ok) logPass("session close");
      else logInfo(`session close warning: ${closed.error.code}: ${closed.error.message}`);
    }
    router.bridges.closeAll();
    router.driver.close();
  }
}

main().then(() => {
  writeNativeReport(true);
}).catch((error) => {
  writeNativeReport(false, error);
  process.stderr.write(`FAIL  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
