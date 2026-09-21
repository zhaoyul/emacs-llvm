import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OperatorError } from "../../../protocol/src/errors.js";

export function captureRuntimeDirectory(env = process.env): string {
  if (env.EMACS_OPERATOR_CAPTURE_DIR) return path.resolve(env.EMACS_OPERATOR_CAPTURE_DIR);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  if (process.platform === "win32") return path.join(os.tmpdir(), "EmacsOperator-Captures");
  return path.join(os.tmpdir(), `emacs-operator-captures-${uid}`);
}

export interface ConsumedCapture {
  data: string;
  mime_type: "image/png";
  bytes: number;
}

export function consumeCapturePNG(file: string, options: { maxBytes?: number; deleteAfterRead?: boolean } = {}): ConsumedCapture {
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  const deleteAfterRead = options.deleteAfterRead !== false;
  const root = path.resolve(captureRuntimeDirectory());
  const candidate = path.resolve(file);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(candidate).toLowerCase() !== ".png") {
    throw new OperatorError("E_CAPTURE_FAILED", "Native host returned a capture outside the authorized transient capture directory.", { file: candidate });
  }
  let stat: any;
  try {
    const linkStat = fs.lstatSync(candidate);
    if (linkStat.isSymbolicLink()) {
      throw new OperatorError("E_CAPTURE_FAILED", "Native capture path must not be a symbolic link.", { file: candidate });
    }
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    const realRelative = path.relative(realRoot, realCandidate);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new OperatorError("E_CAPTURE_FAILED", "Native capture resolves outside the authorized transient capture directory.", { file: candidate });
    }
    stat = fs.statSync(realCandidate);
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    throw new OperatorError("E_CAPTURE_FAILED", "Native capture file no longer exists.", { file: candidate });
  }
  if (!stat.isFile()) throw new OperatorError("E_CAPTURE_FAILED", "Native capture path is not a regular file.");
  if (stat.size <= 0 || stat.size > maxBytes) {
    throw new OperatorError("E_CAPTURE_FAILED", "Native capture size is outside the configured bounds.", { bytes: stat.size, max_bytes: maxBytes });
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new OperatorError("E_CAPTURE_FAILED", "Native capture file permissions are too broad.", { mode: (stat.mode & 0o777).toString(8) });
  }
  try {
    const data = fs.readFileSync(candidate);
    // A PNG starts with an 8-byte fixed signature. Reject foreign files even inside the private directory.
    if (data.length < 8 || !data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new OperatorError("E_CAPTURE_FAILED", "Native capture file is not a valid PNG payload.");
    }
    return { data: data.toString("base64"), mime_type: "image/png", bytes: data.length };
  } finally {
    if (deleteAfterRead) {
      try { fs.unlinkSync(candidate); } catch { /* best effort cleanup */ }
    }
  }
}
