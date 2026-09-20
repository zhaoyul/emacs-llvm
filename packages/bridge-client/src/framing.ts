import { OperatorError } from "../../protocol/src/errors.js";

export class ContentLengthParser {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxMessageBytes = 1024 * 1024) {}

  push(chunk: Buffer | string): string[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    const output: string[] = [];

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lines = header.split("\r\n");
      let contentLength: number | undefined;
      for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const name = line.slice(0, idx).trim().toLowerCase();
        if (name === "content-length") {
          const parsed = Number(line.slice(idx + 1).trim());
          if (!Number.isSafeInteger(parsed) || parsed < 0) {
            throw new OperatorError("E_INVALID_ARGUMENT", "Invalid Content-Length header.");
          }
          contentLength = parsed;
        }
      }
      if (contentLength === undefined) throw new OperatorError("E_INVALID_ARGUMENT", "Missing Content-Length header.");
      if (contentLength > this.maxMessageBytes) {
        throw new OperatorError("E_INVALID_ARGUMENT", "Bridge message exceeds configured size limit.", {
          content_length: contentLength,
          max_message_bytes: this.maxMessageBytes
        });
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) break;
      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength);
      output.push(body.toString("utf8"));
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
    }
    return output;
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }
}

export function encodeContentLengthFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}
