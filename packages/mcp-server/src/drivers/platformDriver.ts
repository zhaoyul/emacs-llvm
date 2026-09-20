import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ContentLengthParser, encodeContentLengthFrame } from "../../../bridge-client/src/framing.js";
import { ERROR_CODES, OperatorError, type ErrorCode } from "../../../protocol/src/errors.js";

export interface DriverCapabilities {
  protocol_version: string;
  connected: boolean;
  platform?: string;
  backend?: string;
  session_type?: string;
  display_server?: string | null;
  display?: string | null;
  unicode_text?: boolean;
  native_keyboard: boolean;
  window_focus: boolean;
  window_capture: boolean;
  frontmost_query: boolean;
  accessibility_trusted: boolean;
  screen_recording_granted: boolean;
  user_interference_monitor?: boolean;
  user_interference_detection?: boolean;
  capture_cursor?: boolean;
  uinput_available?: boolean;
  reason?: string;
  limitations?: string[];
}

export interface DriverPermission {
  name: string;
  status: string;
  granted: boolean;
}

export interface NativeApplicationInfo {
  pid: number;
  bundle_identifier?: string | null;
  name?: string | null;
  window_title?: string | null;
  window_identifier?: string | null;
}

export interface NativeTarget {
  pid: number;
  window_title?: string | null;
  window_identifier?: string | null;
}

export interface NativeFocusOptions {
  raise_window?: boolean;
  restore_frontmost?: boolean;
  timeout_milliseconds?: number;
}

export interface NativeFocusResult {
  previous_frontmost?: NativeApplicationInfo | null;
  focused_application: NativeApplicationInfo;
  focused_window_title?: string | null;
  verified_frontmost: boolean;
}

export interface NativeKeyEvent {
  kind: string;
  key?: string;
  code?: string;
  text?: string;
  modifiers?: string[];
  repeat_count?: number;
  delay_after_milliseconds?: number;
}

export interface NativeInputResult {
  sent_events: number;
  cancelled: boolean;
  user_interference_detected: boolean;
  restored_previous_application: boolean;
  previous_frontmost?: NativeApplicationInfo | null;
}

export interface NativeCaptureResult {
  path: string;
  width: number;
  height: number;
}

export interface PlatformDriver {
  initialize(): Promise<DriverCapabilities>;
  permissions(): Promise<DriverPermission[]>;
  frontmostApplication(): Promise<NativeApplicationInfo>;
  focusEmacs(target: NativeTarget, options?: NativeFocusOptions): Promise<NativeFocusResult>;
  sendKeySequence(target: NativeTarget, events: NativeKeyEvent[], options?: NativeFocusOptions): Promise<NativeInputResult>;
  restoreApplication(application: NativeApplicationInfo): Promise<boolean>;
  captureEmacs(target: NativeTarget, options?: { max_width?: number; include_cursor?: boolean }): Promise<NativeCaptureResult>;
  cancelAll(): Promise<void>;
  close(): void;
}

const unavailableCapabilities = (): DriverCapabilities => ({
  protocol_version: "1.0",
  connected: false,
  native_keyboard: false,
  window_focus: false,
  window_capture: false,
  frontmost_query: false,
  accessibility_trusted: false,
  screen_recording_granted: false
});

export class UnavailablePlatformDriver implements PlatformDriver {
  async initialize(): Promise<DriverCapabilities> { return unavailableCapabilities(); }
  async permissions(): Promise<DriverPermission[]> { return []; }
  async cancelAll(): Promise<void> {}
  close(): void {}

  async frontmostApplication(): Promise<NativeApplicationInfo> { return this.fail(); }
  async focusEmacs(_target: NativeTarget, _options?: NativeFocusOptions): Promise<NativeFocusResult> { return this.fail(); }
  async sendKeySequence(_target: NativeTarget, _events: NativeKeyEvent[], _options?: NativeFocusOptions): Promise<NativeInputResult> { return this.fail(); }
  async restoreApplication(_application: NativeApplicationInfo): Promise<boolean> { return false; }
  async captureEmacs(_target: NativeTarget, _options?: { max_width?: number; include_cursor?: boolean }): Promise<NativeCaptureResult> { return this.fail(); }

  fail(): never {
    throw new OperatorError("E_NATIVE_DRIVER_UNAVAILABLE", "No native platform driver is connected.");
  }
}

interface DriverInstanceRecord {
  protocol_version: string;
  pid: number;
  host: string;
  port: number;
  token_file: string;
  started_at: string;
  heartbeat_at: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

interface DriverRequestOptions {
  allowBeforeInitialization?: boolean;
  timeoutMs?: number;
}

export function driverRuntimeDirectory(env = process.env): string {
  if (env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR) return path.resolve(env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `emacs-operator-driver-${uid}`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function privateOwnedPath(file: string, kind: "directory" | "file"): ReturnType<typeof fs.lstatSync> | undefined {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return undefined;
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) return undefined;
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) return undefined;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return undefined;
  }
  return stat;
}

function pathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readDriverRecord(runtimeDir = driverRuntimeDirectory(), staleAfterMs = 20_000): DriverInstanceRecord | undefined {
  const file = path.join(runtimeDir, "driver.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    if (!privateOwnedPath(runtimeDir, "directory") || !privateOwnedPath(file, "file")) return undefined;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (
      value.protocol_version !== "1.0" ||
      !Number.isInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      value.host !== "127.0.0.1" ||
      !Number.isInteger(value.port) ||
      (value.port as number) < 1 ||
      (value.port as number) > 65535 ||
      typeof value.token_file !== "string" ||
      typeof value.started_at !== "string" ||
      typeof value.heartbeat_at !== "string"
    ) return undefined;
    if (!pathInside(runtimeDir, value.token_file)) return undefined;
    const heartbeat = Date.parse(value.heartbeat_at);
    if (!processAlive(value.pid as number) || !Number.isFinite(heartbeat) || Math.abs(Date.now() - heartbeat) > staleAfterMs) return undefined;
    return value as unknown as DriverInstanceRecord;
  } catch {
    return undefined;
  }
}

function readDriverToken(record: DriverInstanceRecord): string {
  const runtimeDir = path.dirname(record.token_file);
  const stat = privateOwnedPath(record.token_file, "file");
  if (!stat) {
    throw new OperatorError("E_AUTH_FAILED", "Platform driver token must be a private, regular, owner-controlled file.", {
      token_file: record.token_file
    });
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new OperatorError("E_AUTH_FAILED", "Platform driver token file permissions are too broad.", {
      token_file: record.token_file,
      mode: (stat.mode & 0o777).toString(8)
    });
  }
  if (!privateOwnedPath(runtimeDir, "directory")) {
    throw new OperatorError("E_AUTH_FAILED", "Platform driver token directory is not private and owner-controlled.", {
      token_file: record.token_file
    });
  }
  const token = fs.readFileSync(record.token_file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new OperatorError("E_AUTH_FAILED", "Platform driver token file is malformed.");
  return token;
}

class DriverRPCClient {
  private socket: any;
  private readonly parser = new ContentLengthParser();
  private readonly pending = new Map<string | number, PendingRequest>();
  private connected = false;
  private initialized = false;

  constructor(readonly record: DriverInstanceRecord) {}

  async connectAndInitialize(): Promise<DriverCapabilities> {
    await this.connect();
    const result = await this.request<Omit<DriverCapabilities, "connected">>(
      "driver.initialize",
      { token: readDriverToken(this.record) },
      { allowBeforeInitialization: true, timeoutMs: 5_000 }
    );
    this.initialized = true;
    return { ...result, connected: true };
  }

  isReady(): boolean {
    return this.connected && this.initialized && Boolean(this.socket) && !this.socket.destroyed;
  }

  async request<T>(method: string, params: Record<string, unknown> = {}, options: DriverRequestOptions = {}): Promise<T> {
    if (!this.connected) throw new OperatorError("E_NATIVE_DRIVER_UNAVAILABLE", "Platform driver socket is not connected.");
    if (!this.initialized && options.allowBeforeInitialization !== true) throw new OperatorError("E_AUTH_FAILED", "Platform driver connection is not initialized.");
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new OperatorError("E_INVALID_ARGUMENT", "Platform driver RPC timeout must be an integer between 1 and 120000 milliseconds.");
    }
    const id = `driver_${crypto.randomUUID()}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OperatorError("E_COMMAND_TIMEOUT", `Platform driver method ${method} timed out after ${timeoutMs} milliseconds.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeContentLengthFrame({ jsonrpc: "2.0", id, method, params }));
    });
    return (await promise) as T;
  }

  close(): void {
    if (this.socket) this.socket.destroy();
    this.connected = false;
    this.initialized = false;
    this.rejectAll(new OperatorError("E_NATIVE_DRIVER_UNAVAILABLE", "Platform driver connection closed."));
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.record.host, port: this.record.port });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.once("connect", () => { this.connected = true; resolve(); });
      socket.once("error", reject);
      socket.on("data", (chunk: Buffer) => this.onData(chunk));
      socket.on("close", () => this.onClose());
      socket.on("error", (error: Error) => this.onSocketError(error));
    });
  }

  private onData(chunk: Buffer): void {
    try {
      for (const text of this.parser.push(chunk)) {
        const message = JSON.parse(text) as Record<string, unknown>;
        const id = message.id as string | number | undefined;
        if (id === undefined) continue;
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.error && typeof message.error === "object") {
          const rpcError = message.error as Record<string, unknown>;
          const data = rpcError.data as Record<string, unknown> | undefined;
          const code = data?.code;
          if (typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)) {
            pending.reject(new OperatorError(code as ErrorCode, String(rpcError.message ?? code)));
          } else {
            pending.reject(new OperatorError("E_INTERNAL", String(rpcError.message ?? "Platform driver JSON-RPC error.")));
          }
        } else {
          pending.resolve(message.result);
        }
      }
    } catch (error) {
      this.rejectAll(error);
      this.socket?.destroy();
    }
  }

  private onClose(): void {
    this.connected = false;
    this.initialized = false;
    this.rejectAll(new OperatorError("E_NATIVE_DRIVER_UNAVAILABLE", "Platform driver disconnected."));
  }

  private onSocketError(error: Error): void {
    this.rejectAll(new OperatorError("E_NATIVE_DRIVER_UNAVAILABLE", error.message));
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class AutoPlatformDriver implements PlatformDriver {
  private client: DriverRPCClient | undefined;
  private record: DriverInstanceRecord | undefined;
  private capabilities = unavailableCapabilities();

  async initialize(): Promise<DriverCapabilities> {
    const record = readDriverRecord();
    if (!record) {
      this.close();
      return unavailableCapabilities();
    }
    if (this.client?.isReady() && this.record?.pid === record.pid && this.record.port === record.port) return this.capabilities;
    this.close();
    const client = new DriverRPCClient(record);
    try {
      const capabilities = await client.connectAndInitialize();
      this.client = client;
      this.record = record;
      this.capabilities = capabilities;
      return capabilities;
    } catch {
      client.close();
      this.capabilities = unavailableCapabilities();
      return this.capabilities;
    }
  }

  async permissions(): Promise<DriverPermission[]> {
    const client = await this.requireClient();
    return client.request("driver.permissions");
  }

  async frontmostApplication(): Promise<NativeApplicationInfo> {
    const client = await this.requireClient();
    return client.request("driver.frontmost");
  }

  async focusEmacs(target: NativeTarget, options: NativeFocusOptions = {}): Promise<NativeFocusResult> {
    const client = await this.requireClient();
    const focusTimeout = Number.isInteger(options.timeout_milliseconds) ? Number(options.timeout_milliseconds) : 1_500;
    return client.request("driver.focus", { target, options }, { timeoutMs: Math.min(35_000, Math.max(5_000, focusTimeout + 3_000)) });
  }

  async sendKeySequence(target: NativeTarget, events: NativeKeyEvent[], options: NativeFocusOptions = {}): Promise<NativeInputResult> {
    const client = await this.requireClient();
    return client.request(
      "driver.key_sequence",
      { target, sequence: { events }, focus_options: options },
      { timeoutMs: 95_000 }
    );
  }

  async restoreApplication(application: NativeApplicationInfo): Promise<boolean> {
    const client = await this.requireClient();
    const result = await client.request<{ restored: boolean }>("driver.restore_application", { application }, { timeoutMs: 10_000 });
    return result.restored;
  }

  async captureEmacs(target: NativeTarget, options: { max_width?: number; include_cursor?: boolean } = {}): Promise<NativeCaptureResult> {
    const client = await this.requireClient();
    return client.request("driver.capture", { target, options }, { timeoutMs: 20_000 });
  }

  async cancelAll(): Promise<void> {
    // Cancellation must not share the data-plane connection with a long-running
    // key_sequence. Linux/macOS hosts serialize requests per connection, so a
    // cancel request on the active connection could otherwise sit behind the
    // operation it is trying to stop. Use a fresh authenticated control-plane
    // connection and keep cancellation best-effort.
    const record = readDriverRecord();
    if (!record) return;
    const controlClient = new DriverRPCClient(record);
    try {
      await controlClient.connectAndInitialize();
      await controlClient.request("driver.cancel_all", {}, { timeoutMs: 10_000 });
    } catch {
      // Cancellation is intentionally best-effort. Callers still observe the
      // original operation result/error and can re-initialize after a restart.
    } finally {
      controlClient.close();
    }
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
    this.record = undefined;
    this.capabilities = unavailableCapabilities();
  }

  private async requireClient(): Promise<DriverRPCClient> {
    const capabilities = await this.initialize();
    if (!capabilities.connected || !this.client) throw new OperatorError("E_NATIVE_DRIVER_UNAVAILABLE", "No live platform driver was discovered.");
    return this.client;
  }
}
