import fs from "node:fs";
import path from "node:path";
import { ToolRouter } from "./tools/toolRouter.js";

interface ProbeRecord {
  pid: number;
  window_identifier: string;
  title: string;
}

interface Gate {
  name: string;
  status: "pass" | "fail";
  details?: string;
}

const gates: Gate[] = [];
const reportPath = process.env.EMACS_OPERATOR_LINUX_EMACS_NATIVE_REPORT;
const bufferName = process.env.EMACS_OPERATOR_LINUX_EMACS_BUFFER ?? "*Emacs Operator Linux Native Acceptance*";

function pass(name: string, details?: string): void {
  gates.push({ name, status: "pass", ...(details ? { details } : {}) });
  process.stdout.write(`PASS  ${name}${details ? `: ${details}` : ""}\n`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readProbe(name: string): ProbeRecord {
  const file = requireEnv(name);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProbeRecord>;
  if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0 || typeof parsed.window_identifier !== "string" || typeof parsed.title !== "string") {
    throw new Error(`${name} is not a valid X11 probe record.`);
  }
  return parsed as ProbeRecord;
}

function unwrap(envelope: Awaited<ReturnType<ToolRouter["call"]>>, name: string): Record<string, any> {
  if (!envelope.ok) throw new Error(`${name} failed: ${envelope.error.code}: ${envelope.error.message}`);
  return envelope.result as Record<string, any>;
}

function writeReport(ok: boolean, error?: unknown): void {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    schema_version: "1.0",
    platform: "linux",
    backend: "x11_xtest",
    target: "real_emacs",
    completed_at: new Date().toISOString(),
    ok,
    gates,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
  }, null, 2)}\n`);
}

async function readBuffer(router: ToolRouter, sessionId: string): Promise<string> {
  const observed = unwrap(await router.call("emacs_observe", {
    session_id: sessionId,
    scope: ["compact"]
  }), "emacs_observe");
  const buffer = observed.buffer && typeof observed.buffer === "object" ? observed.buffer as Record<string, unknown> : {};
  const pointMin = typeof buffer.point_min === "number" ? Math.floor(buffer.point_min) : 1;
  const pointMax = typeof buffer.point_max === "number" ? Math.floor(buffer.point_max) : undefined;
  if (pointMax === undefined) throw new Error("Emacs observation did not expose point_max.");
  const read = unwrap(await router.call("emacs_read", {
    session_id: sessionId,
    start: pointMin,
    end: pointMax,
    max_chars: 65_536
  }), "emacs_read");
  if (typeof read.text !== "string") throw new Error("emacs_read did not return text.");
  return read.text;
}

async function waitForBuffer(router: ToolRouter, sessionId: string, expectedPrefix: string, timeoutMs = 5000): Promise<string> {
  const started = Date.now();
  let latest = "";
  while (Date.now() - started <= timeoutMs) {
    latest = await readBuffer(router, sessionId);
    if (latest.startsWith(expectedPrefix)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for real Emacs buffer prefix ${JSON.stringify(expectedPrefix)}. Latest text: ${JSON.stringify(latest)}`);
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Linux real-Emacs native acceptance can run only on Linux.");
  const previous = readProbe("EMACS_OPERATOR_LINUX_PREVIOUS_READY");
  const router = new ToolRouter();
  let sessionId: string | undefined;
  try {
    const driver = await router.driver.initialize();
    if (!driver.connected || driver.backend !== "x11_xtest" || !driver.native_keyboard || !driver.window_capture) {
      throw new Error(`An active x11_xtest Linux Host is required: ${JSON.stringify(driver)}`);
    }
    pass("real Emacs driver discovery", `backend=${driver.backend}, display=${String(driver.display)}`);

    const instances = unwrap(await router.call("emacs_instances", {}), "emacs_instances");
    const candidates = Array.isArray(instances.instances) ? instances.instances as Array<Record<string, unknown>> : [];
    const requested = process.env.EMACS_OPERATOR_LINUX_EMACS_INSTANCE_ID;
    const instance = requested
      ? candidates.find((item) => item.instance_id === requested)
      : candidates.find((item) => item.stale !== true && item.process_alive !== false && item.system_type === "gnu/linux");
    if (!instance || typeof instance.instance_id !== "string") {
      throw new Error("No live GNU/Linux Emacs Operator instance was discovered.");
    }
    pass("real Emacs bridge discovery", `instance=${instance.instance_id}, pid=${String(instance.pid)}`);

    const opened = unwrap(await router.call("emacs_session_open", {
      selector: { instance_id: instance.instance_id, buffer_name: bufferName },
      default_channel: "native_keys",
      permission_profile: "trusted_local"
    }), "emacs_session_open");
    sessionId = opened.session.sessionId as string;
    if (opened.capabilities.channels.native_keys !== true) throw new Error("Real Emacs session did not advertise native_keys.");
    if (!opened.session.target.nativeWindowIdentifier && !opened.session.target.frameTitle) {
      throw new Error("Real Emacs session did not resolve a GUI frame/window identity.");
    }
    pass("real Emacs GUI target", `buffer=${bufferName}, window=${String(opened.session.target.nativeWindowIdentifier ?? opened.session.target.frameTitle)}`);

    const before = await router.driver.frontmostApplication();
    if (before.pid !== previous.pid) throw new Error(`Expected previous probe PID ${previous.pid} before native input, got ${before.pid}.`);
    pass("real Emacs foreground lease precondition", `pid=${before.pid}`);

    const initial = await readBuffer(router, sessionId);
    if (initial !== "ABCDE\n") throw new Error(`Real Emacs acceptance buffer has unexpected initial text: ${JSON.stringify(initial)}`);
    pass("real Emacs initial semantic observation", JSON.stringify(initial));

    const execution = unwrap(await router.call("emacs_key_sequence", {
      session_id: sessionId,
      channel: "native_keys",
      restore_frontmost: true,
      steps: [
        { kind: "event", event: { kind: "key_press", key: "a", modifiers: ["control"] } },
        { kind: "text", value: "你X" }
      ]
    }), "emacs_key_sequence");
    if (execution.execution.sent_events < 6) throw new Error("Real Emacs native sequence reported too few physical events.");
    pass("real Emacs XTEST delivery", `${execution.execution.sent_events} physical events`);

    const text = await waitForBuffer(router, sessionId, "你XABCDE\n");
    if (text !== "你XABCDE\n") throw new Error(`Real Emacs buffer contains unexpected text after native input: ${JSON.stringify(text)}`);
    pass("real Emacs command-loop effect", "Ctrl+A moved point and Unicode text reached the buffer");

    const restored = await router.driver.frontmostApplication();
    if (restored.pid !== previous.pid) throw new Error(`Real Emacs foreground restoration failed: expected ${previous.pid}, got ${restored.pid}.`);
    pass("real Emacs foreground restoration", `pid=${restored.pid}`);

    const capture = unwrap(await router.call("emacs_capture", {
      session_id: sessionId,
      max_width: 480,
      include_cursor: false
    }), "emacs_capture");
    const png = Buffer.from(String(capture.image_data ?? ""), "base64");
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (capture.mime_type !== "image/png" || capture.transient_file_consumed !== true || !png.subarray(0, 8).equals(signature)) {
      throw new Error("Real Emacs window capture was not returned as a consumed PNG.");
    }
    pass("real Emacs window capture", `${String(capture.width)}x${String(capture.height)}, ${String(capture.bytes)} bytes`);
  } finally {
    if (sessionId) await router.call("emacs_session_close", { session_id: sessionId });
    router.bridges.closeAll();
    router.driver.close();
  }
}

main().then(() => writeReport(true)).catch((error) => {
  gates.push({ name: "linux real Emacs native acceptance", status: "fail", details: error instanceof Error ? error.message : String(error) });
  writeReport(false, error);
  process.stderr.write(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
