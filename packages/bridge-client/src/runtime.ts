import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OperatorError } from "../../protocol/src/errors.js";
import type { EmacsInstanceRecord } from "../../protocol/src/types.js";

export function runtimeDirectory(env = process.env): string {
  if (env.EMACS_OPERATOR_RUNTIME_DIR) return path.resolve(env.EMACS_OPERATOR_RUNTIME_DIR);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  if (process.platform === "linux" && env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, "emacs-operator");
  if (process.platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "EmacsOperator", "runtime");
  }
  return path.join(os.tmpdir(), `emacs-operator-${uid}`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is EmacsInstanceRecord {
  if (!value || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  return (
    typeof x.instance_id === "string" &&
    typeof x.pid === "number" &&
    x.host === "127.0.0.1" &&
    typeof x.port === "number" &&
    typeof x.token_file === "string" &&
    typeof x.heartbeat_at === "string"
  );
}

export interface DiscoveredInstance {
  record: EmacsInstanceRecord;
  stale: boolean;
  process_alive: boolean;
}

export function discoverInstances(options: { runtimeDir?: string; staleAfterMs?: number } = {}): DiscoveredInstance[] {
  const dir = options.runtimeDir ?? runtimeDirectory();
  const staleAfterMs = options.staleAfterMs ?? 20_000;
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  const found: DiscoveredInstance[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^instance-.*\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!isRecord(raw)) continue;
      const heartbeat = Date.parse(raw.heartbeat_at);
      const alive = processAlive(raw.pid);
      found.push({
        record: raw,
        stale: !alive || !Number.isFinite(heartbeat) || now - heartbeat > staleAfterMs,
        process_alive: alive
      });
    } catch {
      // Ignore partially-written or foreign files; the next discovery pass can recover.
    }
  }
  return found.sort((a, b) => a.record.instance_id.localeCompare(b.record.instance_id));
}

export function readInstanceToken(record: EmacsInstanceRecord): string {
  const stat = fs.statSync(record.token_file);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new OperatorError("E_AUTH_FAILED", "Emacs bridge token file permissions are too broad.", {
      token_file: record.token_file,
      mode: (stat.mode & 0o777).toString(8)
    });
  }
  const token = fs.readFileSync(record.token_file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new OperatorError("E_AUTH_FAILED", "Bridge token file is malformed.");
  return token;
}
