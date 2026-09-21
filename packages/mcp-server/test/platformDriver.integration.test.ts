import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { ContentLengthParser, encodeContentLengthFrame } from "../../bridge-client/src/framing.js";
import { AutoPlatformDriver } from "../src/drivers/platformDriver.js";

test("AutoPlatformDriver discovers, authenticates, and calls a loopback native host", async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-driver-test-"));
  const token = "b".repeat(64);
  const tokenFile = path.join(runtimeDir, "token");
  fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });

  const server = net.createServer((socket: any) => {
    const parser = new ContentLengthParser();
    let authorized = false;
    socket.on("data", (chunk: Buffer) => {
      for (const text of parser.push(chunk)) {
        const request = JSON.parse(text) as any;
        const reply = (result: unknown) => socket.write(encodeContentLengthFrame({ jsonrpc: "2.0", id: request.id, result }));
        if (request.method === "driver.initialize") {
          assert.equal(request.params.token, token);
          authorized = true;
          reply({
            protocol_version: "1.0",
            native_keyboard: false,
            window_focus: true,
            window_capture: false,
            frontmost_query: true,
            accessibility_trusted: true,
            screen_recording_granted: false
          });
          continue;
        }
        assert.equal(authorized, true);
        if (request.method === "driver.permissions") {
          reply([{ name: "accessibility", status: "granted", granted: true }]);
        } else if (request.method === "driver.frontmost") {
          reply({ pid: 321, bundle_identifier: "org.gnu.Emacs", name: "Emacs" });
        } else if (request.method === "driver.focus") {
          reply({ focused_application: { pid: request.params.target.pid, name: "Emacs" }, verified_frontmost: true });
        } else if (request.method === "driver.cancel_all") {
          reply({ cancelled: true });
        } else {
          socket.write(encodeContentLengthFrame({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "unsupported", data: { code: "E_NATIVE_DRIVER_UNAVAILABLE" } } }));
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as any;
  fs.writeFileSync(path.join(runtimeDir, "driver.json"), JSON.stringify({
    protocol_version: "1.0",
    pid: process.pid,
    host: "127.0.0.1",
    port: address.port,
    token_file: tokenFile,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString()
  }), { mode: 0o600 });

  const previous = process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR = runtimeDir;
  const driver = new AutoPlatformDriver();
  try {
    const capabilities = await driver.initialize();
    assert.equal(capabilities.connected, true);
    assert.equal(capabilities.window_focus, true);
    assert.equal(capabilities.native_keyboard, false);

    const permissions = await driver.permissions();
    assert.equal(permissions[0]?.granted, true);

    const frontmost = await driver.frontmostApplication();
    assert.equal(frontmost.name, "Emacs");

    const focus = await driver.focusEmacs({ pid: 999 });
    assert.equal(focus.verified_frontmost, true);
    assert.equal(focus.focused_application.pid, 999);
  } finally {
    driver.close();
    if (previous === undefined) delete process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("AutoPlatformDriver rejects discovery records that escape the private runtime directory", async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-driver-escape-test-"));
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-driver-external-test-"));
  const tokenFile = path.join(externalDir, "token");
  fs.writeFileSync(tokenFile, "c".repeat(64) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(runtimeDir, "driver.json"), JSON.stringify({
    protocol_version: "1.0",
    pid: process.pid,
    host: "127.0.0.1",
    port: 65535,
    token_file: tokenFile,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString()
  }), { mode: 0o600 });

  const previous = process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR = runtimeDir;
  const driver = new AutoPlatformDriver();
  try {
    const capabilities = await driver.initialize();
    assert.equal(capabilities.connected, false);
  } finally {
    driver.close();
    if (previous === undefined) delete process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR = previous;
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});

test("AutoPlatformDriver rejects a symbolic-link discovery record", async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-driver-symlink-test-"));
  const tokenFile = path.join(runtimeDir, "token");
  const realRecord = path.join(runtimeDir, "real-driver.json");
  fs.writeFileSync(tokenFile, "d".repeat(64) + "\n", { mode: 0o600 });
  fs.writeFileSync(realRecord, JSON.stringify({
    protocol_version: "1.0",
    pid: process.pid,
    host: "127.0.0.1",
    port: 65535,
    token_file: tokenFile,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString()
  }), { mode: 0o600 });
  fs.symlinkSync(realRecord, path.join(runtimeDir, "driver.json"));

  const previous = process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR = runtimeDir;
  const driver = new AutoPlatformDriver();
  try {
    const capabilities = await driver.initialize();
    assert.equal(capabilities.connected, false);
  } finally {
    driver.close();
    if (previous === undefined) delete process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR = previous;
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("AutoPlatformDriver cancelAll uses an independent control connection", async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-driver-cancel-test-"));
  const token = "e".repeat(64);
  const tokenFile = path.join(runtimeDir, "token");
  fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });

  let connectionCount = 0;
  let keySequenceStartedResolve!: () => void;
  const keySequenceStarted = new Promise<void>((resolve) => { keySequenceStartedResolve = resolve; });
  let cancelResolve!: () => void;
  const cancelled = new Promise<void>((resolve) => { cancelResolve = resolve; });

  const server = net.createServer((socket: any) => {
    connectionCount += 1;
    const parser = new ContentLengthParser();
    let authorized = false;
    let chain = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      for (const text of parser.push(chunk)) {
        const request = JSON.parse(text) as any;
        chain = chain.then(async () => {
          const reply = (result: unknown) => socket.write(encodeContentLengthFrame({ jsonrpc: "2.0", id: request.id, result }));
          if (request.method === "driver.initialize") {
            assert.equal(request.params.token, token);
            authorized = true;
            reply({
              protocol_version: "1.0",
              native_keyboard: true,
              window_focus: true,
              window_capture: true,
              frontmost_query: true,
              accessibility_trusted: true,
              screen_recording_granted: true
            });
            return;
          }
          assert.equal(authorized, true);
          if (request.method === "driver.key_sequence") {
            keySequenceStartedResolve();
            await cancelled;
            reply({
              sent_events: 3,
              cancelled: true,
              user_interference_detected: false,
              restored_previous_application: false,
              previous_frontmost: null
            });
            return;
          }
          if (request.method === "driver.cancel_all") {
            cancelResolve();
            reply({ cancelled: true });
            return;
          }
          socket.write(encodeContentLengthFrame({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32000, message: "unsupported", data: { code: "E_NATIVE_DRIVER_UNAVAILABLE" } }
          }));
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as any;
  fs.writeFileSync(path.join(runtimeDir, "driver.json"), JSON.stringify({
    protocol_version: "1.0",
    pid: process.pid,
    host: "127.0.0.1",
    port: address.port,
    token_file: tokenFile,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString()
  }), { mode: 0o600 });

  const previous = process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR;
  process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR = runtimeDir;
  const driver = new AutoPlatformDriver();
  try {
    const capabilities = await driver.initialize();
    assert.equal(capabilities.connected, true);

    const sequencePromise = driver.sendKeySequence(
      { pid: process.pid },
      [{ kind: "key_press", key: "a", delay_after_milliseconds: 500 }]
    );
    await keySequenceStarted;

    const startedAt = Date.now();
    await driver.cancelAll();
    const cancelElapsedMs = Date.now() - startedAt;
    const result = await sequencePromise;

    assert.equal(result.cancelled, true);
    assert.ok(connectionCount >= 2, `expected a separate control connection, observed ${connectionCount}`);
    assert.ok(cancelElapsedMs < 2_000, `cancelAll took ${cancelElapsedMs}ms`);
  } finally {
    driver.close();
    if (previous === undefined) delete process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR;
    else process.env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
