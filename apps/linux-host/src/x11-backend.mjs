import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateCaptureDirectory } from "./runtime.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultHelper = path.resolve(moduleDirectory, "../build/x11-helper");
const VALID_CODES = new Set([
  "E_INVALID_ARGUMENT", "E_AUTH_FAILED", "E_PERMISSION_DENIED", "E_NATIVE_DRIVER_UNAVAILABLE", "E_TARGET_NOT_FOUND", "E_FOCUS_FAILED",
  "E_FRONTMOST_MISMATCH", "E_INPUT_INJECTION_FAILED", "E_CAPTURE_FAILED", "E_MUTATION_LOCKED", "E_INTERNAL"
]);

const MODIFIER_CANONICAL = new Map([
  ["control", "control"],
  ["shift", "shift"],
  ["alt", "alt"],
  ["meta", "alt"],
  ["option", "alt"],
  ["super", "super"],
  ["command", "super"],
  ["hyper", "hyper"]
]);

export class LinuxDriverError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "LinuxDriverError";
    this.code = VALID_CODES.has(code) ? code : "E_INTERNAL";
    this.details = details;
  }
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new LinuxDriverError("E_INVALID_ARGUMENT", `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return candidate;
}

function base64(value) {
  return Buffer.from(value ?? "", "utf8").toString("base64");
}

function eventIdentity(event) {
  return `${String(event.code ?? "")}\0${String(event.key ?? "")}`;
}

export function validateAndEncodeEvents(events) {
  if (!Array.isArray(events) || events.length === 0) throw new LinuxDriverError("E_INVALID_ARGUMENT", "Native sequence requires at least one event.");
  if (events.length > 4096) throw new LinuxDriverError("E_INVALID_ARGUMENT", "Native sequence exceeds 4096 logical events.");
  const held = new Set();
  let textBytes = 0;
  let totalDelay = 0;
  const rows = [];
  const allowedKinds = new Set(["key_press", "key_down", "key_up", "text"]);
  const allowedModifiers = new Set(["control", "meta", "shift", "super", "hyper", "alt", "command", "option"]);

  for (const [index, raw] of events.entries()) {
    if (!raw || typeof raw !== "object") throw new LinuxDriverError("E_INVALID_ARGUMENT", `events[${index}] must be an object.`);
    const kind = String(raw.kind ?? "").toLowerCase();
    if (!allowedKinds.has(kind)) throw new LinuxDriverError("E_INVALID_ARGUMENT", `Unsupported native event kind: ${kind || "<empty>"}.`);
    const repeat = boundedInteger(raw.repeat_count, 1, 1, 100, `events[${index}].repeat_count`);
    const delay = boundedInteger(raw.delay_after_milliseconds, 0, 0, 10_000, `events[${index}].delay_after_milliseconds`);
    totalDelay += delay;
    if (totalDelay > 60_000) throw new LinuxDriverError("E_INVALID_ARGUMENT", "Native sequence delay budget exceeds 60 seconds.");
    const modifiers = raw.modifiers === undefined ? [] : raw.modifiers;
    if (!Array.isArray(modifiers) || modifiers.some((item) => typeof item !== "string" || !allowedModifiers.has(item))) {
      throw new LinuxDriverError("E_INVALID_ARGUMENT", `events[${index}].modifiers contains an unsupported Linux/X11 modifier.`);
    }
    const canonicalModifiers = modifiers.map((item) => MODIFIER_CANONICAL.get(item));
    if (canonicalModifiers.some((item) => item === undefined) || new Set(canonicalModifiers).size !== canonicalModifiers.length) {
      throw new LinuxDriverError("E_INVALID_ARGUMENT", `events[${index}].modifiers contains duplicate or alias-equivalent modifiers.`);
    }
    const key = typeof raw.key === "string" ? raw.key : "";
    const code = typeof raw.code === "string" ? raw.code : "";
    const text = typeof raw.text === "string" ? raw.text : "";
    if (key.includes("\0") || code.includes("\0") || text.includes("\0")) {
      throw new LinuxDriverError("E_INVALID_ARGUMENT", `events[${index}] cannot contain NUL characters.`);
    }
    if (Buffer.byteLength(key, "utf8") > 128 || Buffer.byteLength(code, "utf8") > 128) {
      throw new LinuxDriverError("E_INVALID_ARGUMENT", `events[${index}] key/code exceeds 128 UTF-8 bytes.`);
    }

    if (kind === "text") {
      if (!text) continue;
      textBytes += Buffer.byteLength(text, "utf8") * repeat;
      if (textBytes > 65_536) throw new LinuxDriverError("E_INVALID_ARGUMENT", "Native text payload exceeds 64 KiB.");
      if (modifiers.length) throw new LinuxDriverError("E_INVALID_ARGUMENT", "Text events cannot carry modifiers on the X11 backend.");
    } else if (!key && !code) {
      throw new LinuxDriverError("E_INVALID_ARGUMENT", `events[${index}] requires key or code.`);
    }

    if ((kind === "key_down" || kind === "key_up") && repeat !== 1) {
      throw new LinuxDriverError("E_INVALID_ARGUMENT", `${kind} cannot be repeated; use balanced explicit events.`);
    }
    if (kind === "key_down") {
      const identity = eventIdentity(raw);
      if (held.has(identity)) throw new LinuxDriverError("E_INVALID_ARGUMENT", `events[${index}] repeats an already-held key.`);
      held.add(identity);
    } else if (kind === "key_up") {
      const identity = eventIdentity(raw);
      if (!held.delete(identity)) throw new LinuxDriverError("E_INVALID_ARGUMENT", `events[${index}] has no matching key_down.`);
    }

    rows.push([
      kind, base64(key), base64(code), base64(text), base64(canonicalModifiers.join(",")), String(repeat), String(delay)
    ].join("\t"));
  }
  if (held.size) throw new LinuxDriverError("E_INVALID_ARGUMENT", "Native sequence contains unbalanced key_down events.");
  if (rows.length === 0) throw new LinuxDriverError("E_INVALID_ARGUMENT", "Native sequence contains no effective events.");
  return `${rows.join("\n")}\n`;
}

async function runProcess(executable, args, { timeoutMs = 10_000, maxOutputBytes = 1_048_576, signal } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const append = (current, chunk) => {
      if (current.length >= maxOutputBytes) return current;
      const room = maxOutputBytes - current.length;
      return Buffer.concat([current, chunk.subarray(0, room)]);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const terminate = () => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { child.kill("SIGTERM"); }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      terminate();
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 250).unref();
    }, timeoutMs);
    const onAbort = () => terminate();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.once("error", (error) => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code, closeSignal) => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal: closeSignal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

function parseHelperResponse(processResult, command) {
  let parsed;
  const line = processResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  try { parsed = JSON.parse(line ?? ""); } catch {
    throw new LinuxDriverError("E_INTERNAL", `X11 helper ${command} returned malformed JSON.`, {
      exit_code: processResult.code,
      stderr: processResult.stderr.slice(-2000)
    });
  }
  if (parsed?.ok !== true) {
    throw new LinuxDriverError(parsed?.code, String(parsed?.message ?? `X11 helper ${command} failed.`), {
      exit_code: processResult.code,
      stderr: processResult.stderr.slice(-2000)
    });
  }
  if (processResult.code !== 0) throw new LinuxDriverError("E_INTERNAL", `X11 helper ${command} exited with code ${processResult.code}.`);
  return parsed;
}

export class X11Backend {
  #activeAbortControllers = new Set();
  #operationTail = Promise.resolve();
  #closed = false;

  constructor({ helperPath = process.env.EMACS_OPERATOR_LINUX_X11_HELPER ?? defaultHelper, runtimeDirectory }) {
    this.helperPath = path.resolve(helperPath);
    this.runtimeDirectory = runtimeDirectory;
    if (!fs.existsSync(this.helperPath)) throw new LinuxDriverError("E_NATIVE_DRIVER_UNAVAILABLE", `X11 helper is missing: ${this.helperPath}`);
  }

  async #serialize(operation) {
    const run = this.#operationTail.then(async () => {
      if (this.#closed) throw new LinuxDriverError("E_NATIVE_DRIVER_UNAVAILABLE", "The Linux X11 backend is closed.");
      return await operation();
    });
    this.#operationTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async #run(command, args = [], options = {}) {
    const controller = new AbortController();
    this.#activeAbortControllers.add(controller);
    try {
      const result = await runProcess(this.helperPath, [command, ...args], { ...options, signal: controller.signal });
      return parseHelperResponse(result, command);
    } finally {
      this.#activeAbortControllers.delete(controller);
    }
  }

  async capabilities() {
    const result = await this.#run("capabilities");
    return {
      protocol_version: "1.0",
      native_keyboard: result.xtest === true,
      window_focus: result.window_focus === true,
      window_capture: result.window_capture === true,
      frontmost_query: result.frontmost_query === true,
      accessibility_trusted: result.xtest === true,
      screen_recording_granted: result.window_capture === true,
      platform: "linux",
      backend: "x11_xtest",
      session_type: "x11",
      display_server: "x11",
      display: result.display,
      unicode_text: result.unicode_dynamic_mapping === true,
      user_interference_monitor: false,
      user_interference_detection: false,
      capture_cursor: false,
      uinput_available: fs.existsSync("/dev/uinput") || fs.existsSync("/dev/input/uinput"),
      limitations: [
        "X11 native input cannot reliably detect concurrent human input in Alpha.13.",
        "Cursor compositing is not available in X11 window captures.",
        "Wayland-native focus, injection, and capture are not claimed by this backend."
      ]
    };
  }

  async permissions() {
    const capabilities = await this.capabilities();
    return [
      { name: "x11_display", status: capabilities.window_focus ? "granted" : "denied", granted: capabilities.window_focus },
      { name: "x11_xtest", status: capabilities.native_keyboard ? "granted" : "denied", granted: capabilities.native_keyboard },
      { name: "x11_window_capture", status: capabilities.window_capture ? "granted" : "denied", granted: capabilities.window_capture },
      { name: "user_interference_detection", status: "unsupported", granted: false }
    ];
  }

  #targetArguments(target) {
    if (!target || !Number.isInteger(target.pid) || target.pid <= 0) throw new LinuxDriverError("E_INVALID_ARGUMENT", "Native target requires a positive PID.");
    const args = ["--pid", String(target.pid)];
    if (typeof target.window_title === "string" && target.window_title) args.push("--title", target.window_title);
    if (typeof target.window_identifier === "string" && target.window_identifier) args.push("--window-id", target.window_identifier);
    return args;
  }

  async frontmostApplication() {
    return await this.#serialize(async () => {
      const result = await this.#run("frontmost");
      return result.application;
    });
  }

  async focusEmacs(target, options = {}) {
    return await this.#serialize(async () => {
      const timeout = boundedInteger(options.timeout_milliseconds, 1500, 1, 30_000, "timeout_milliseconds");
      const result = await this.#run("focus", [...this.#targetArguments(target), "--timeout-ms", String(timeout)], { timeoutMs: timeout + 2500 });
      return {
        previous_frontmost: result.previous_frontmost ?? null,
        focused_application: result.focused_application,
        focused_window_title: result.focused_window_title ?? null,
        verified_frontmost: result.verified_frontmost === true
      };
    });
  }

  async sendKeySequence(target, events, options = {}) {
    const plan = validateAndEncodeEvents(events);
    return await this.#serialize(async () => {
      const file = path.join(this.runtimeDirectory, `.events-${process.pid}-${crypto.randomUUID()}.tsv`);
      fs.writeFileSync(file, plan, { mode: 0o600, flag: "wx" });
      fs.chmodSync(file, 0o600);
      try {
        const timeout = boundedInteger(options.timeout_milliseconds, 1500, 1, 30_000, "timeout_milliseconds");
        const args = [...this.#targetArguments(target), "--events", file, "--timeout-ms", String(timeout)];
        if (options.restore_frontmost === true) args.push("--restore");
        const result = await this.#run("sequence", args, { timeoutMs: 90_000 });
        return {
          sent_events: result.sent_events,
          cancelled: result.cancelled === true,
          user_interference_detected: result.user_interference_detected === true,
          restored_previous_application: result.restored_previous_application === true,
          previous_frontmost: result.previous_frontmost ?? null
        };
      } finally {
        try { fs.unlinkSync(file); } catch { /* best effort */ }
      }
    });
  }

  async restoreApplication(application) {
    if (!application || !Number.isInteger(application.pid) || application.pid <= 0) return false;
    return await this.#serialize(async () => {
      const target = {
        pid: application.pid,
        window_title: typeof application.window_title === "string" ? application.window_title : undefined,
        window_identifier: typeof application.window_identifier === "string" ? application.window_identifier : undefined
      };
      try {
        const result = await this.#run("restore", this.#targetArguments(target));
        return result.restored === true;
      } catch {
        return false;
      }
    });
  }

  async captureEmacs(target, options = {}) {
    if (options.include_cursor === true) throw new LinuxDriverError("E_INVALID_ARGUMENT", "The X11 capture backend does not support cursor compositing.");
    return await this.#serialize(async () => {
      const maximumWidth = boundedInteger(options.max_width, 2048, 1, 8192, "max_width");
      const captureDirectory = ensurePrivateCaptureDirectory();
      const output = path.join(captureDirectory, `capture-${process.pid}-${crypto.randomUUID()}.png`);
      const result = await this.#run("capture", [
        ...this.#targetArguments(target), "--output", output, "--max-width", String(maximumWidth)
      ], { timeoutMs: 15_000 });
      return { path: result.path, width: result.width, height: result.height };
    });
  }

  async cancelAll() {
    for (const controller of this.#activeAbortControllers) controller.abort();
  }

  close() {
    this.#closed = true;
    for (const controller of this.#activeAbortControllers) controller.abort();
  }
}

export class UnavailableLinuxBackend {
  constructor(reason) { this.reason = reason instanceof Error ? reason.message : String(reason); }
  async capabilities() {
    return {
      protocol_version: "1.0", native_keyboard: false, window_focus: false, window_capture: false,
      frontmost_query: false, accessibility_trusted: false, screen_recording_granted: false,
      platform: "linux", backend: "unavailable", session_type: process.env.WAYLAND_DISPLAY ? "wayland" : "none",
      display_server: process.env.WAYLAND_DISPLAY ? "wayland" : null, display: process.env.DISPLAY ?? null,
      reason: this.reason, user_interference_monitor: false, user_interference_detection: false, capture_cursor: false,
      uinput_available: fs.existsSync("/dev/uinput") || fs.existsSync("/dev/input/uinput"), limitations: [this.reason]
    };
  }
  async permissions() { return [{ name: "linux_native_backend", status: "unavailable", granted: false, reason: this.reason }]; }
  fail() { throw new LinuxDriverError("E_NATIVE_DRIVER_UNAVAILABLE", this.reason); }
  async frontmostApplication() { return this.fail(); }
  async focusEmacs() { return this.fail(); }
  async sendKeySequence() { return this.fail(); }
  async restoreApplication() { return false; }
  async captureEmacs() { return this.fail(); }
  async cancelAll() {}
  close() {}
}

export async function createLinuxBackend(options) {
  const requested = process.env.EMACS_OPERATOR_LINUX_BACKEND ?? "auto";
  if (!new Set(["auto", "x11"]).has(requested)) {
    return new UnavailableLinuxBackend(`Linux backend ${requested} is not implemented in this release. Use x11 or internal_keys.`);
  }
  if (!process.env.DISPLAY) {
    return new UnavailableLinuxBackend(process.env.WAYLAND_DISPLAY
      ? "Wayland-only session detected. This release does not claim generic Wayland focus/injection; use internal_keys or launch under XWayland/X11."
      : "DISPLAY is not set. Start an X11 session or use semantic/internal_keys.");
  }
  try {
    const backend = new X11Backend(options);
    await backend.capabilities();
    return backend;
  } catch (error) {
    return new UnavailableLinuxBackend(error);
  }
}
