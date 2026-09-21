const HEADER_DELIMITER = Buffer.from("\r\n\r\n", "ascii");

export class ContentLengthFramer {
  #buffer = Buffer.alloc(0);

  constructor({ maximumMessageBytes = 1_048_576, maximumHeaderBytes = 16_384 } = {}) {
    this.maximumMessageBytes = maximumMessageBytes;
    this.maximumHeaderBytes = maximumHeaderBytes;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const messages = [];

    while (this.#buffer.length > 0) {
      const headerEnd = this.#buffer.indexOf(HEADER_DELIMITER);
      if (headerEnd < 0) {
        if (this.#buffer.length > this.maximumHeaderBytes) throw new Error("Driver RPC header exceeds the configured limit.");
        break;
      }
      if (headerEnd > this.maximumHeaderBytes) throw new Error("Driver RPC header exceeds the configured limit.");
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      let contentLength;
      for (const line of header.split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        if (line.slice(0, separator).trim().toLowerCase() !== "content-length") continue;
        if (contentLength !== undefined) throw new Error("Driver RPC frame contains duplicate Content-Length headers.");
        const raw = line.slice(separator + 1).trim();
        if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error("Driver RPC Content-Length is invalid.");
        contentLength = Number(raw);
      }
      if (!Number.isSafeInteger(contentLength)) throw new Error("Driver RPC frame is missing Content-Length.");
      if (contentLength > this.maximumMessageBytes) throw new Error("Driver RPC message exceeds the configured limit.");
      const bodyStart = headerEnd + HEADER_DELIMITER.length;
      const bodyEnd = bodyStart + contentLength;
      if (this.#buffer.length < bodyEnd) break;
      messages.push(this.#buffer.subarray(bodyStart, bodyEnd));
      this.#buffer = this.#buffer.subarray(bodyEnd);
    }
    return messages;
  }
}

export function encodeContentLengthFrame(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n`, "ascii"),
    body
  ]);
}
