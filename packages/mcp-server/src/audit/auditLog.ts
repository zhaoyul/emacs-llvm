import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { AuditEntry } from "../../../protocol/src/types.js";

function defaultAuditPath(): string {
  const base = process.env.EMACS_OPERATOR_AUDIT_DIR || path.join(os.tmpdir(), `emacs-operator-audit-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return path.join(base, "audit.jsonl");
}

export class AuditLog {
  readonly file: string;

  constructor(file = defaultAuditPath()) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }

  newId(): string {
    return `aud_${crypto.randomUUID()}`;
  }

  append(entry: AuditEntry): void {
    const safe: AuditEntry = { ...entry };
    fs.appendFileSync(this.file, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
    }
  }
}
