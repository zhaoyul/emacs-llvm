import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDriverRuntime } from "../src/runtime.mjs";

test("driver runtime creates private authenticated discovery files", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-linux-runtime-test-"));
  try {
    const runtime = createDriverRuntime({ EMACS_OPERATOR_DRIVER_RUNTIME_DIR: path.join(parent, "driver") });
    runtime.writeRecord(12345);
    assert.equal(fs.statSync(runtime.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(runtime.tokenFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(runtime.recordFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(runtime.lockFile).mode & 0o777, 0o600);
    assert.match(runtime.token, /^[a-f0-9]{64}$/);
    assert.throws(
      () => createDriverRuntime({ EMACS_OPERATOR_DRIVER_RUNTIME_DIR: runtime.directory }),
      /already active/i
    );
    const record = JSON.parse(fs.readFileSync(runtime.recordFile, "utf8"));
    assert.equal(record.host, "127.0.0.1");
    assert.equal(record.port, 12345);
    assert.equal(record.platform, "linux");
    runtime.cleanup();
    assert.equal(fs.existsSync(runtime.tokenFile), false);
    assert.equal(fs.existsSync(runtime.recordFile), false);
    assert.equal(fs.existsSync(runtime.lockFile), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("driver runtime refuses a symbolic-link runtime directory before changing its target", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-linux-runtime-symlink-test-"));
  const target = path.join(parent, "target");
  const link = path.join(parent, "driver");
  fs.mkdirSync(target, { mode: 0o755 });
  fs.symlinkSync(target, link);
  try {
    assert.throws(
      () => createDriverRuntime({ EMACS_OPERATOR_DRIVER_RUNTIME_DIR: link }),
      /not a private directory/i
    );
    assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("driver runtime replaces a stale token symlink without following it", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-linux-runtime-token-test-"));
  const directory = path.join(parent, "driver");
  const sentinel = path.join(parent, "sentinel");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(sentinel, "do-not-overwrite\n", { mode: 0o600 });
  fs.symlinkSync(sentinel, path.join(directory, "token"));
  try {
    const runtime = createDriverRuntime({ EMACS_OPERATOR_DRIVER_RUNTIME_DIR: directory });
    assert.equal(fs.readFileSync(sentinel, "utf8"), "do-not-overwrite\n");
    assert.equal(fs.lstatSync(runtime.tokenFile).isSymbolicLink(), false);
    assert.match(fs.readFileSync(runtime.tokenFile, "utf8").trim(), /^[a-f0-9]{64}$/);
    runtime.cleanup();
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
