import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { consumeCapturePNG } from "../src/drivers/captureFiles.js";
import { OperatorError } from "../../protocol/src/errors.js";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("consumeCapturePNG validates private PNG and deletes it after embedding", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-capture-ts-"));
  const previous = process.env.EMACS_OPERATOR_CAPTURE_DIR;
  process.env.EMACS_OPERATOR_CAPTURE_DIR = root;
  try {
    const file = path.join(root, "capture-test.png");
    fs.writeFileSync(file, ONE_PIXEL_PNG, { mode: 0o600 });
    const result = consumeCapturePNG(file);
    assert.equal(result.mime_type, "image/png");
    assert.equal(Buffer.from(result.data, "base64").equals(ONE_PIXEL_PNG), true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    if (previous === undefined) delete process.env.EMACS_OPERATOR_CAPTURE_DIR;
    else process.env.EMACS_OPERATOR_CAPTURE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("consumeCapturePNG rejects paths outside the private capture directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-capture-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-capture-outside-"));
  const previous = process.env.EMACS_OPERATOR_CAPTURE_DIR;
  process.env.EMACS_OPERATOR_CAPTURE_DIR = root;
  try {
    const file = path.join(outside, "foreign.png");
    fs.writeFileSync(file, ONE_PIXEL_PNG, { mode: 0o600 });
    assert.throws(() => consumeCapturePNG(file), (error: unknown) => error instanceof OperatorError && error.code === "E_CAPTURE_FAILED");
  } finally {
    if (previous === undefined) delete process.env.EMACS_OPERATOR_CAPTURE_DIR;
    else process.env.EMACS_OPERATOR_CAPTURE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("consumeCapturePNG rejects symlinks even when the link is inside the private capture directory", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-capture-link-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-capture-link-outside-"));
  const previous = process.env.EMACS_OPERATOR_CAPTURE_DIR;
  process.env.EMACS_OPERATOR_CAPTURE_DIR = root;
  try {
    const real = path.join(outside, "real.png");
    const link = path.join(root, "capture-link.png");
    fs.writeFileSync(real, ONE_PIXEL_PNG, { mode: 0o600 });
    fs.symlinkSync(real, link);
    assert.throws(
      () => consumeCapturePNG(link),
      (error: unknown) => error instanceof OperatorError && error.code === "E_CAPTURE_FAILED" && /symbolic link/.test(error.message)
    );
  } finally {
    if (previous === undefined) delete process.env.EMACS_OPERATOR_CAPTURE_DIR;
    else process.env.EMACS_OPERATOR_CAPTURE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
