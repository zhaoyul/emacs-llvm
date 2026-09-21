import fs from "node:fs";
import path from "node:path";
import { ToolRouter } from "./tools/toolRouter.js";
import { FakeEmacsBridge } from "../../test-harness/src/fakeBridge.js";

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
const reportPath = process.env.EMACS_OPERATOR_LINUX_NATIVE_REPORT;

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

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readEvents(file: string): Array<Record<string, any>> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line: string) => JSON.parse(line) as Record<string, any>);
}

function hasPress(events: Array<Record<string, any>>, predicate: (event: Record<string, any>) => boolean): boolean {
  return events.some((event) => event.type === "key_press" && predicate(event));
}

function writeReport(ok: boolean, error?: unknown): void {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    schema_version: "1.0",
    platform: "linux",
    backend: "x11_xtest",
    completed_at: new Date().toISOString(),
    ok,
    gates,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
  }, null, 2)}\n`);
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Linux native acceptance can run only on Linux.");
  const target = readProbe("EMACS_OPERATOR_LINUX_TARGET_READY");
  const previous = readProbe("EMACS_OPERATOR_LINUX_PREVIOUS_READY");
  const eventLog = requireEnv("EMACS_OPERATOR_LINUX_TARGET_LOG");

  const fake = new FakeEmacsBridge({
    nativePid: target.pid,
    nativeWindowIdentifier: target.window_identifier,
    frameTitle: target.title
  });
  await fake.start();
  const oldRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = fake.runtimeDir;
  const router = new ToolRouter();
  let sessionId: string | undefined;
  try {
    const driver = await router.driver.initialize();
    if (!driver.connected) throw new Error("Linux Host was not discovered through driver.json.");
    if (driver.native_keyboard !== true || driver.window_focus !== true || driver.window_capture !== true) {
      throw new Error(`Linux Host capabilities are incomplete: ${JSON.stringify(driver)}`);
    }
    if (driver.backend !== "x11_xtest") throw new Error("Linux Host did not select x11_xtest.");
    pass("driver discovery", `backend=${String(driver.backend)}, display=${String(driver.display)}`);

    const permissions = await router.driver.permissions();
    if (!permissions.some((item) => item.name === "x11_xtest" && item.granted)) throw new Error("XTEST permission/capability was not granted.");
    pass("capability negotiation", `${permissions.filter((item) => item.granted).length} Linux capabilities granted`);

    const before = await router.driver.frontmostApplication();
    if (before.pid !== previous.pid) throw new Error(`Expected previous probe PID ${previous.pid} to be focused, got ${before.pid}.`);
    pass("initial frontmost application", `pid=${before.pid}`);

    const opened = unwrap(await router.call("emacs_session_open", {
      selector: { instance_id: fake.instanceId, file: path.join(fake.runtimeDir, "linux-native.el") },
      default_channel: "native_keys",
      permission_profile: "trusted_local"
    }), "emacs_session_open");
    sessionId = opened.session.sessionId as string;
    if (opened.capabilities.channels.native_keys !== true) throw new Error("Session did not advertise native_keys.");
    pass("session native capability", `session=${sessionId}`);

    const execution = unwrap(await router.call("emacs_key_sequence", {
      session_id: sessionId,
      channel: "native_keys",
      restore_frontmost: true,
      steps: [
        { kind: "event", event: { kind: "key_press", key: "a" } },
        { kind: "event", event: { kind: "key_press", key: "x", modifiers: ["control"] } },
        { kind: "text", value: "Z你" },
        { kind: "event", event: { kind: "key_press", key: "left" } }
      ]
    }), "emacs_key_sequence");
    if (execution.execution.sent_events < 10) throw new Error("Native driver reported too few physical events.");
    pass("MCP to XTEST key injection", `${execution.execution.sent_events} physical events`);

    await waitFor(() => {
      const events = readEvents(eventLog);
      return hasPress(events, (event) => event.unicode === 20320) && hasPress(events, (event) => event.keysym_name === "Left");
    });
    const events = readEvents(eventLog);
    if (!hasPress(events, (event) => event.keysym_name === "a" && event.state === 0)) throw new Error("Plain a KeyPress was not observed.");
    if (!hasPress(events, (event) => event.keysym_name === "x" && (event.state & 4) === 4)) throw new Error("Control-x KeyPress was not observed with ControlMask.");
    if (!hasPress(events, (event) => event.keysym_name === "Z" && (event.state & 1) === 1)) throw new Error("Uppercase Z was not observed with ShiftMask.");
    if (!hasPress(events, (event) => event.unicode === 20320 && event.keysym_name === "U4F60")) throw new Error("Unicode U+4F60 was not observed through the dynamic X11 mapping.");
    if (!hasPress(events, (event) => event.keysym_name === "Left")) throw new Error("Left arrow KeyPress was not observed.");
    pass("canonical key semantics", "plain, modifier, shifted, Unicode, and navigation keys observed");

    const restored = await router.driver.frontmostApplication();
    if (restored.pid !== previous.pid) throw new Error(`Foreground restoration failed: expected ${previous.pid}, got ${restored.pid}.`);
    pass("foreground restoration", `pid=${restored.pid}`);

    const capture = unwrap(await router.call("emacs_capture", {
      session_id: sessionId,
      max_width: 320,
      include_cursor: false
    }), "emacs_capture");
    if (capture.mime_type !== "image/png" || capture.transient_file_consumed !== true) throw new Error("Capture was not consumed as a transient PNG.");
    const png = Buffer.from(capture.image_data, "base64");
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!png.subarray(0, 8).equals(signature)) throw new Error("Capture payload does not have a PNG signature.");
    if (capture.width !== 320 || capture.height <= 0 || capture.bytes <= 100) throw new Error("Capture dimensions or payload size are invalid.");
    pass("private window capture", `${capture.width}x${capture.height}, ${capture.bytes} bytes`);

    const unbalanced = await router.call("emacs_key_sequence", {
      session_id: sessionId,
      channel: "native_keys",
      steps: [{ kind: "event", event: { kind: "key_down", key: "a" } }]
    });
    if (unbalanced.ok || unbalanced.error.code !== "E_INVALID_ARGUMENT") throw new Error("Unbalanced key_down was not rejected before injection.");
    pass("stuck-key prevention", unbalanced.error.code);

    const cursorCapture = await router.call("emacs_capture", {
      session_id: sessionId,
      include_cursor: true
    });
    if (cursorCapture.ok || cursorCapture.error.code !== "E_INVALID_ARGUMENT") throw new Error("Unsupported cursor capture was not reported explicitly.");
    pass("unsupported capability honesty", "cursor capture rejected explicitly");
  } finally {
    if (sessionId) await router.call("emacs_session_close", { session_id: sessionId });
    router.bridges.closeAll();
    router.driver.close();
    if (oldRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = oldRuntime;
    await fake.stop();
  }
}

main().then(() => {
  writeReport(true);
}).catch((error) => {
  gates.push({ name: "linux native acceptance", status: "fail", details: error instanceof Error ? error.message : String(error) });
  writeReport(false, error);
  process.stderr.write(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
