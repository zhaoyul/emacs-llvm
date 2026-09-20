import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./canonical.mjs";
import { redact } from "./redaction.mjs";
export class TraceWriter {
  constructor(tracePath, { includePrompt = false } = {}) {
    this.tracePath = tracePath;
    this.includePrompt = includePrompt;
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    this.stream = fs.createWriteStream(tracePath, { flags: "a", mode: 0o600 });
    this.sequence = 0;
  }
  write(type, payload = {}) {
    const safe = { ...payload };
    if (typeof safe.prompt === "string" && !this.includePrompt) {
      safe.prompt_sha256 = sha256(safe.prompt);
      safe.prompt_bytes = Buffer.byteLength(safe.prompt);
      delete safe.prompt;
    }
    const record = { sequence: ++this.sequence, timestamp: new Date().toISOString(), type, payload: redact(safe) };
    this.stream.write(`${JSON.stringify(record)}
`);
    return record;
  }
  async close() { await new Promise((resolve, reject) => this.stream.end((error) => error ? reject(error) : resolve())); }
}
export function traceDigest(tracePath) { return sha256(fs.readFileSync(tracePath)); }
