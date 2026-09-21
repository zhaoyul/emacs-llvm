import net from "node:net";
import crypto from "node:crypto";
import { ERROR_CODES, OperatorError, type ErrorCode } from "../../protocol/src/errors.js";
import type { EmacsInstanceRecord } from "../../protocol/src/types.js";
import { ContentLengthParser, encodeContentLengthFrame } from "./framing.js";
import { readInstanceToken } from "./runtime.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeClient {
  private socket: any;
  private readonly parser = new ContentLengthParser();
  private readonly pending = new Map<string | number, PendingRequest>();
  private connected = false;
  private initialized = false;

  constructor(readonly record: EmacsInstanceRecord) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.record.host, port: this.record.port });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.once("connect", () => {
        this.connected = true;
        resolve();
      });
      socket.once("error", reject);
      socket.on("data", (chunk: Buffer) => this.onData(chunk));
      socket.on("close", () => this.onClose());
      socket.on("error", (error: Error) => this.onSocketError(error));
    });
  }

  async initialize(token = readInstanceToken(this.record)): Promise<Record<string, unknown>> {
    if (!this.connected) await this.connect();
    const result = await this.request<Record<string, unknown>>("initialize", {
      token,
      client: { name: "emacs-operator-mcp-server", version: "0.1.0" }
    });
    this.initialized = true;
    return result;
  }

  async connectAndInitialize(): Promise<Record<string, unknown>> {
    await this.connect();
    return this.initialize();
  }

  async request<T>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number; requestId?: string } = {}): Promise<T> {
    if (!this.connected) throw new OperatorError("E_EMACS_DISCONNECTED", "Bridge socket is not connected.");
    if (!this.initialized && method !== "initialize") {
      throw new OperatorError("E_AUTH_FAILED", "Bridge connection must be initialized before other requests.");
    }
    const id = options.requestId ?? `rpc_${crypto.randomUUID()}`;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OperatorError("E_COMMAND_TIMEOUT", `Bridge method ${method} timed out.`, { timeout_ms: timeoutMs }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeContentLengthFrame(message));
    });
    return (await promise) as T;
  }

  close(): void {
    if (this.socket) this.socket.destroy();
    this.connected = false;
    this.initialized = false;
    this.rejectAll(new OperatorError("E_EMACS_DISCONNECTED", "Bridge connection closed."));
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
            pending.reject(new OperatorError(code as ErrorCode, String(rpcError.message ?? code), data?.details as Record<string, unknown> | undefined));
          } else {
            pending.reject(new OperatorError("E_COMMAND_FAILED", String(rpcError.message ?? "Bridge JSON-RPC error."), { rpc_code: rpcError.code ?? null }));
          }
        } else {
          pending.resolve(message.result);
        }
      }
    } catch (error) {
      this.rejectAll(error);
      if (this.socket) this.socket.destroy();
    }
  }

  private onClose(): void {
    this.connected = false;
    this.initialized = false;
    this.rejectAll(new OperatorError("E_EMACS_DISCONNECTED", "Emacs bridge disconnected."));
  }

  private onSocketError(error: Error): void {
    this.rejectAll(new OperatorError("E_EMACS_DISCONNECTED", error.message));
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
