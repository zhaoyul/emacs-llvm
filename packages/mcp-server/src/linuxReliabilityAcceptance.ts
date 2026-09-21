import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";

const { spawn } = childProcess;
type ChildProcess = any;
import { AutoPlatformDriver, type NativeTarget } from "./drivers/platformDriver.js";

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
const reportPath = process.env.EMACS_OPERATOR_LINUX_RELIABILITY_REPORT;
const root = process.cwd();

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
  const parsed = JSON.parse(fs.readFileSync(requireEnv(name), "utf8")) as Partial<ProbeRecord>;
  if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0 || typeof parsed.window_identifier !== "string" || typeof parsed.title !== "string") {
    throw new Error(`${name} is not a valid X11 probe record.`);
  }
  return parsed as ProbeRecord;
}

function target(record: ProbeRecord): NativeTarget {
  return { pid: record.pid, window_identifier: record.window_identifier, window_title: record.title };
}

function readEvents(file: string): Array<Record<string, any>> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line: string) => JSON.parse(line));
}

function keyPressNames(file: string, offset = 0): string[] {
  return readEvents(file).slice(offset)
    .filter((event) => event.type === "key_press")
    .map((event) => String(event.keysym_name ?? ""));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitChild(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`Process ${child.pid ?? "?"} did not exit within ${timeoutMs} ms.`)), timeoutMs))
  ]);
}

async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try { await waitChild(child, 2_000); } catch {
    child.kill("SIGKILL");
    await waitChild(child, 2_000).catch(() => {});
  }
}

async function runFocus(record: ProbeRecord): Promise<void> {
  const helper = path.join(root, "apps/linux-host/build/x11-helper");
  const child = spawn(helper, ["focus", "--pid", String(record.pid), "--window-id", record.window_identifier, "--timeout-ms", "1500"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  await waitChild(child);
  if (child.exitCode !== 0) throw new Error(`x11-helper focus failed: ${stderr || stdout}`);
}

function spawnHost(runtimeDir: string, captureDir: string): ChildProcess {
  return spawn(process.execPath, [path.join(root, "apps/linux-host/src/host.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      EMACS_OPERATOR_DRIVER_RUNTIME_DIR: runtimeDir,
      EMACS_OPERATOR_CAPTURE_DIR: captureDir,
      EMACS_OPERATOR_LINUX_BACKEND: "x11"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
}

function readDriverPid(runtimeDir: string): number | undefined {
  const file = path.join(runtimeDir, "driver.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isInteger(value.pid) ? value.pid : undefined;
  } catch { return undefined; }
}

async function spawnProbe(directory: string, title: string): Promise<{ child: ChildProcess; record: ProbeRecord; log: string }> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ready = path.join(directory, "ready.json");
  const log = path.join(directory, "events.jsonl");
  const child = spawn(path.join(root, "apps/linux-host/build/x11-probe"), ["--title", title, "--log", log, "--ready", ready], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"]
  });
  await waitFor(() => fs.existsSync(ready) && fs.statSync(ready).size > 0, 5_000);
  const parsed = JSON.parse(fs.readFileSync(ready, "utf8")) as ProbeRecord;
  return { child, record: parsed, log };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as any).code) : undefined;
}

function writeReport(ok: boolean, error?: unknown): void {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    schema_version: "1.0",
    platform: "linux",
    suite: "linux-reliability-v1",
    completed_at: new Date().toISOString(),
    ok,
    gates,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
  }, null, 2)}\n`);
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Linux reliability acceptance can run only on Linux.");
  const targetProbe = readProbe("EMACS_OPERATOR_LINUX_TARGET_READY");
  const previousProbe = readProbe("EMACS_OPERATOR_LINUX_PREVIOUS_READY");
  const targetLog = requireEnv("EMACS_OPERATOR_LINUX_TARGET_LOG");
  const previousLog = requireEnv("EMACS_OPERATOR_LINUX_PREVIOUS_LOG");
  const originalRuntime = requireEnv("EMACS_OPERATOR_DRIVER_RUNTIME_DIR");

  const driver = new AutoPlatformDriver();
  try {
    const capabilities = await driver.initialize();
    if (!capabilities.connected || capabilities.backend !== "x11_xtest" || !capabilities.native_keyboard) {
      throw new Error(`X11 driver is unavailable: ${JSON.stringify(capabilities)}`);
    }
    pass("live X11 driver", `pid=${readDriverPid(originalRuntime) ?? "unknown"}`);

    // Cancellation must run over an independent control-plane connection and
    // the native helper must clean up a key held at the cancellation point.
    await runFocus(previousProbe);
    const targetBeforeCancel = readEvents(targetLog).length;
    const cancelSequence = driver.sendKeySequence(target(targetProbe), [
      { kind: "key_down", key: "control", delay_after_milliseconds: 2_000 },
      { kind: "key_up", key: "control" }
    ], { restore_frontmost: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cancelStarted = Date.now();
    await driver.cancelAll();
    const cancelLatencyMs = Date.now() - cancelStarted;
    const cancelled = await cancelSequence;
    if (!cancelled.cancelled) throw new Error("Long sequence did not report cancelled=true.");
    if (cancelLatencyMs > 1_500) throw new Error(`Cancellation latency was ${cancelLatencyMs} ms.`);
    await waitFor(() => {
      const cancelEvents = readEvents(targetLog).slice(targetBeforeCancel).filter((event) => event.keysym_name === "Control_L");
      return cancelEvents.some((event) => event.type === "key_press") && cancelEvents.some((event) => event.type === "key_release");
    });
    const cancelEvents = readEvents(targetLog).slice(targetBeforeCancel).filter((event) => event.keysym_name === "Control_L");
    const downCount = cancelEvents.filter((event) => event.type === "key_press").length;
    const upCount = cancelEvents.filter((event) => event.type === "key_release").length;
    if (downCount !== upCount || downCount < 1) throw new Error(`Held-modifier cleanup was not balanced after cancellation: down=${downCount}, up=${upCount}.`);
    const frontAfterCancel = await driver.frontmostApplication();
    if (frontAfterCancel.pid !== previousProbe.pid) throw new Error("Foreground application was not restored after cancellation.");
    pass("mid-sequence cancellation", `${cancelLatencyMs} ms, balanced held-key cleanup`);

    const postCancelOffset = readEvents(targetLog).length;
    await driver.sendKeySequence(target(targetProbe), [{ kind: "key_press", key: "b" }], { restore_frontmost: true });
    await waitFor(() => keyPressNames(targetLog, postCancelOffset).includes("b"));
    const postEvents = readEvents(targetLog).slice(postCancelOffset).filter((event) => event.type === "key_press" && event.keysym_name === "b");
    if (postEvents.some((event) => Number(event.state ?? 0) !== 0)) throw new Error("Post-cancellation key inherited a stuck modifier state.");
    pass("post-cancel recovery", "next plain key had no stuck modifier state");

    // If focus is stolen while a sequence is active, no subsequent keys may
    // leak into the newly focused application.
    await runFocus(previousProbe);
    const targetFocusOffset = readEvents(targetLog).length;
    const previousFocusOffset = readEvents(previousLog).length;
    const focusSequence = driver.sendKeySequence(
      target(targetProbe),
      Array.from({ length: 20 }, () => ({ kind: "key_press", key: "c", delay_after_milliseconds: 120 })),
      { restore_frontmost: true }
    );
    await new Promise((resolve) => setTimeout(resolve, 280));
    await runFocus(previousProbe);
    let focusError: unknown;
    try { await focusSequence; } catch (error) { focusError = error; }
    if (codeOf(focusError) !== "E_FRONTMOST_MISMATCH") throw focusError ?? new Error("Focus theft did not abort the sequence.");
    const leaked = keyPressNames(previousLog, previousFocusOffset).filter((name) => name === "c");
    if (leaked.length !== 0) throw new Error(`Focus theft leaked ${leaked.length} key(s) into the previous window.`);
    const targetPresses = keyPressNames(targetLog, targetFocusOffset).filter((name) => name === "c").length;
    if (targetPresses < 1 || targetPresses >= 20) throw new Error(`Focus-theft sequence was not partially executed as expected (${targetPresses}).`);
    pass("focus-theft fail-closed", `${targetPresses}/20 target presses, 0 leaked presses`);

    // Two data-plane connections may submit operations concurrently, but the
    // shared backend must preserve whole-sequence desktop serialization.
    await runFocus(previousProbe);
    const serialOffset = readEvents(targetLog).length;
    const secondDriver = new AutoPlatformDriver();
    try {
      await secondDriver.initialize();
      const first = driver.sendKeySequence(target(targetProbe), Array.from({ length: 4 }, () => ({ kind: "key_press", key: "d", delay_after_milliseconds: 50 })));
      const second = secondDriver.sendKeySequence(target(targetProbe), Array.from({ length: 4 }, () => ({ kind: "key_press", key: "e", delay_after_milliseconds: 50 })));
      await Promise.all([first, second]);
      const names = keyPressNames(targetLog, serialOffset).filter((name) => name === "d" || name === "e");
      const joined = names.join("");
      if (joined !== "ddddeeee" && joined !== "eeeedddd") throw new Error(`Concurrent desktop operations interleaved: ${joined}`);
      pass("concurrent desktop lease serialization", joined);
    } finally {
      secondDriver.close();
      await driver.restoreApplication({ pid: previousProbe.pid, name: "previous", window_identifier: previousProbe.window_identifier, window_title: previousProbe.title });
    }

    // Target destruction must stop injection and return a target-specific
    // error, then restore the original foreground application.
    await runFocus(previousProbe);
    const vanishRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-vanish-"));
    let vanishing: Awaited<ReturnType<typeof spawnProbe>> | undefined;
    try {
      vanishing = await spawnProbe(vanishRoot, "Emacs Operator Vanishing Probe");
      const vanishingSequence = driver.sendKeySequence(
        target(vanishing.record),
        Array.from({ length: 20 }, () => ({ kind: "key_press", key: "f", delay_after_milliseconds: 120 })),
        { restore_frontmost: true }
      );
      await new Promise((resolve) => setTimeout(resolve, 280));
      await terminate(vanishing.child);
      let vanishError: unknown;
      try { await vanishingSequence; } catch (error) { vanishError = error; }
      if (codeOf(vanishError) !== "E_TARGET_NOT_FOUND") throw vanishError ?? new Error("Destroyed target did not stop native input.");
      const front = await driver.frontmostApplication();
      if (front.pid !== previousProbe.pid) throw new Error(`Foreground was not restored after target destruction (pid=${front.pid}).`);
      pass("target disappearance fail-closed", "E_TARGET_NOT_FOUND with foreground restoration");
    } finally {
      await terminate(vanishing?.child);
      fs.rmSync(vanishRoot, { recursive: true, force: true });
    }

    // Exercise repeated key/capture/restore cycles. Driver-level capture files
    // are deliberately consumed here so the private capture directory must end
    // empty.
    await runFocus(previousProbe);
    const captureDir = requireEnv("EMACS_OPERATOR_CAPTURE_DIR");
    for (let index = 0; index < 12; index += 1) {
      const result = await driver.sendKeySequence(target(targetProbe), [{ kind: "key_press", key: "g" }], { restore_frontmost: true });
      if (result.cancelled) throw new Error(`Soak key cycle ${index} was unexpectedly cancelled.`);
      const front = await driver.frontmostApplication();
      if (front.pid !== previousProbe.pid) throw new Error(`Soak cycle ${index} failed foreground restoration.`);
      const capture = await driver.captureEmacs(target(targetProbe), { max_width: 160, include_cursor: false });
      const stat = fs.lstatSync(capture.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 100) throw new Error(`Soak capture ${index} is invalid.`);
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`Soak capture ${index} permissions are too broad.`);
      fs.unlinkSync(capture.path);
    }
    const captureResidue = fs.existsSync(captureDir) ? fs.readdirSync(captureDir).filter((name: string) => name.endsWith(".png")) : [];
    if (captureResidue.length) throw new Error(`Soak capture left ${captureResidue.length} PNG file(s) behind.`);
    pass("X11 key/capture soak", "12 cycles, no foreground drift or capture residue");
  } finally {
    driver.close();
  }

  // Restart recovery uses the same AutoPlatformDriver object across two Linux
  // Host processes, proving discovery record changes are noticed and the old
  // socket is not reused.
  const restartRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-restart-"));
  const restartRuntime = path.join(restartRoot, "driver");
  const restartCapture = path.join(restartRoot, "capture");
  const savedRuntime = process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR;
  let host1: ChildProcess | undefined;
  let host2: ChildProcess | undefined;
  const restartDriver = new AutoPlatformDriver();
  try {
    process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR = restartRuntime;
    host1 = spawnHost(restartRuntime, restartCapture);
    await waitFor(() => readDriverPid(restartRuntime) === host1?.pid, 5_000);
    const firstCaps = await restartDriver.initialize();
    if (!firstCaps.connected) throw new Error("First restart-test Host was not discovered.");
    const firstPid = readDriverPid(restartRuntime);

    await terminate(host1);
    await waitFor(() => !fs.existsSync(path.join(restartRuntime, "driver.json")), 5_000).catch(() => {});
    host2 = spawnHost(restartRuntime, restartCapture);
    await waitFor(() => {
      const pid = readDriverPid(restartRuntime);
      return pid === host2?.pid && pid !== firstPid;
    }, 5_000);
    const secondCaps = await restartDriver.initialize();
    if (!secondCaps.connected || secondCaps.backend !== "x11_xtest") throw new Error("AutoPlatformDriver did not reconnect after Linux Host restart.");
    pass("driver restart recovery", `pid ${firstPid ?? "?"} -> ${readDriverPid(restartRuntime) ?? "?"}`);
  } finally {
    restartDriver.close();
    await terminate(host1);
    await terminate(host2);
    if (savedRuntime === undefined) delete process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR = savedRuntime;
    fs.rmSync(restartRoot, { recursive: true, force: true });
  }
}

main().then(() => {
  writeReport(true);
}).catch((error) => {
  gates.push({ name: "linux reliability acceptance", status: "fail", details: error instanceof Error ? error.message : String(error) });
  writeReport(false, error);
  process.stderr.write(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
