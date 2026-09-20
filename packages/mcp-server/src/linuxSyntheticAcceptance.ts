import fs from "node:fs";
import path from "node:path";
import { ToolRouter } from "./tools/toolRouter.js";
import { FakeEmacsBridge } from "../../test-harness/src/fakeBridge.js";
import type { ToolEnvelope } from "../../protocol/src/index.js";

interface AnyRecord { [key: string]: unknown }
interface Gate { name: string; status: "pass" | "fail" | "info"; details?: string }

const report = {
  schema_version: "1.0",
  acceptance: "linux_x11_synthetic",
  started_at: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}`,
  node: process.version,
  gates: [] as Gate[]
};

function requiredInteger(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function requiredStringEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function asRecord(value: unknown, label: string): AnyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object.`);
  return value as AnyRecord;
}

function unwrap(envelope: ToolEnvelope<unknown>, label: string): AnyRecord {
  if (!envelope.ok) throw new Error(`${label}: ${envelope.error.code}: ${envelope.error.message}`);
  return asRecord(envelope.result, `${label}.result`);
}

function pass(name: string, details?: string): void {
  report.gates.push({ name, status: "pass", ...(details ? { details } : {}) });
  process.stdout.write(`PASS  ${name}${details ? `  ${details}` : ""}\n`);
}

function info(name: string, details: string): void {
  report.gates.push({ name, status: "info", details });
  process.stdout.write(`INFO  ${name}  ${details}\n`);
}

function writeReport(ok: boolean, error?: unknown): void {
  if (error) report.gates.push({ name: "linux synthetic acceptance", status: "fail", details: error instanceof Error ? error.message : String(error) });
  const output = {
    ...report,
    finished_at: new Date().toISOString(),
    summary: {
      passed: report.gates.filter((item) => item.status === "pass").length,
      failed: report.gates.filter((item) => item.status === "fail").length,
      info: report.gates.filter((item) => item.status === "info").length,
      ok
    }
  };
  const destination = process.env.EMACS_OPERATOR_LINUX_SYNTHETIC_REPORT;
  if (destination) {
    const full = path.resolve(destination);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`INFO  report  ${full}\n`);
  }
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Linux synthetic acceptance must run on Linux.");
  const targetPid = requiredInteger("EMACS_OPERATOR_LINUX_TARGET_PID");
  const targetWindowId = requiredStringEnvironment("EMACS_OPERATOR_LINUX_TARGET_WINDOW_ID");
  const otherPid = requiredInteger("EMACS_OPERATOR_LINUX_OTHER_PID");
  const commandFile = requiredStringEnvironment("EMACS_OPERATOR_LINUX_COMMAND_FILE");
  const eventFile = requiredStringEnvironment("EMACS_OPERATOR_LINUX_EVENT_FILE");

  const bridge = new FakeEmacsBridge({
    nativePid: targetPid,
    nativeWindowIdentifier: targetWindowId,
    frameTitle: "Linux Synthetic GNU Emacs",
    externalCommandFile: commandFile
  });
  await bridge.start();
  const previousRuntime = process.env.EMACS_OPERATOR_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_RUNTIME_DIR = bridge.runtimeDir;
  const router = new ToolRouter();
  let sessionId: string | undefined;
  try {
    const health = unwrap(await router.call("emacs_health", {}), "emacs_health");
    const driver = asRecord(health.native_driver, "native_driver");
    if (driver.connected !== true) throw new Error("Linux Host was not discovered.");
    if (driver.platform !== "linux") throw new Error(`Expected Linux Host, got ${String(driver.platform)}.`);
    if (driver.backend !== "x11_xtest") throw new Error(`Expected x11_xtest backend, got ${String(driver.backend)}.`);
    if (driver.native_keyboard !== true || driver.window_focus !== true || driver.window_capture !== true) {
      throw new Error("Linux Host did not advertise keyboard, focus and capture.");
    }
    pass("Linux Host capability discovery", `backend=${String(driver.backend)} display=${String(driver.display ?? process.env.DISPLAY)}`);

    const before = await router.driver.frontmostApplication();
    if (before.pid !== otherPid) throw new Error(`Expected synthetic companion PID ${otherPid} to be frontmost, got ${before.pid}.`);
    pass("frontmost query", `pid=${before.pid}`);

    const opened = unwrap(await router.call("emacs_session_open", {
      selector: { instance_id: bridge.instanceId },
      permission_profile: "trusted_local",
      default_channel: "semantic"
    }), "emacs_session_open");
    const session = asRecord(opened.session, "session");
    sessionId = String(session.sessionId);
    pass("synthetic Emacs session", `session=${sessionId} target_pid=${targetPid}`);

    const resolved = unwrap(await router.call("emacs_capabilities", {
      session_id: sessionId,
      operation: "resolve_key",
      key: "C-a"
    }), "resolve C-a");
    const expectedCommand = String(resolved.command);
    if (expectedCommand !== "fake-command") throw new Error(`Unexpected fake command ${expectedCommand}.`);

    const native = unwrap(await router.call("emacs_key_sequence", {
      session_id: sessionId,
      channel: "native_keys",
      steps: [
        { kind: "event", event: { kind: "key_press", key: "a", code: "KeyA", modifiers: ["control"], delayAfterMs: 25 } },
        { kind: "text", value: "Az1" }
      ],
      verify: { expected_command: expectedCommand },
      restore_frontmost: true
    }), "native key sequence");
    const verification = asRecord(native.verification, "native verification");
    if (verification.matched !== true || verification.observed_command !== expectedCommand) {
      throw new Error(`Native verification failed: ${JSON.stringify(verification)}.`);
    }
    pass("MCP -> Driver RPC -> XTEST -> target -> Bridge verification", `command=${expectedCommand}`);

    const readEvents = (): AnyRecord[] => fs.existsSync(eventFile)
      ? fs.readFileSync(eventFile, "utf8").trim().split("\n").filter(Boolean).map((line: string) => JSON.parse(line) as AnyRecord)
      : [];
    const isControlA = (item: AnyRecord): boolean => item.type === "key_press" && String(item.keysym_name).toLowerCase() === "a" && item.control === true;
    const isShiftedA = (item: AnyRecord): boolean => item.type === "key_press" && String(item.keysym_name).toLowerCase() === "a" && item.shift === true;
    const deadline = Date.now() + 2000;
    let events = readEvents();
    while ((!events.some(isControlA) || !events.some(isShiftedA)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      events = readEvents();
    }
    const controlA = events.find(isControlA);
    const shiftedA = events.find(isShiftedA);
    if (!controlA) throw new Error("Synthetic X11 target did not receive Control+A through XTEST.");
    if (!shiftedA) throw new Error("Synthetic X11 target did not receive shifted A text input.");
    pass("X11 event semantics", `events=${events.length}, ctrl-a=true, shifted-A=true`);

    const after = await router.driver.frontmostApplication();
    if (after.pid !== otherPid) throw new Error(`Foreground restoration expected PID ${otherPid}, got ${after.pid}.`);
    pass("foreground restoration", `pid=${after.pid}`);

    const capture = unwrap(await router.call("emacs_capture", {
      session_id: sessionId,
      max_width: 320,
      include_cursor: false
    }), "emacs_capture");
    if (capture.mime_type !== "image/png" || capture.transient_file_consumed !== true) {
      throw new Error(`Unexpected capture result: ${JSON.stringify(capture)}.`);
    }
    const bytes = Number(capture.bytes);
    const width = Number(capture.width);
    const height = Number(capture.height);
    if (!(bytes > 64 && width > 0 && width <= 320 && height > 0)) throw new Error("Captured PNG metadata is invalid.");
    pass("window capture and transient cleanup", `${width}x${height}, ${bytes} bytes`);

    const permissions = await router.driver.permissions();
    if (!permissions.some((item) => item.name === "x11_xtest" && item.granted)) throw new Error("XTEST permission/capability was not reported.");
    pass("permission/capability report", `${permissions.length} entries`);
    info("acceptance scope", "Synthetic X11 target validates native plumbing; real GNU Emacs behavior is covered by accept:linux-real when Emacs is installed.");
  } finally {
    if (sessionId) await router.call("emacs_session_close", { session_id: sessionId });
    router.bridges.closeAll();
    router.driver.close();
    await bridge.stop();
    if (previousRuntime === undefined) delete process.env.EMACS_OPERATOR_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_RUNTIME_DIR = previousRuntime;
  }
}

main().then(() => writeReport(true)).catch((error) => {
  writeReport(false, error);
  process.stderr.write(`FAIL  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
