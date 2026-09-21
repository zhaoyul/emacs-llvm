import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ContentLengthFramer, encodeContentLengthFrame } from "../src/framing.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const hostPath = path.resolve(testDirectory, "../src/host.mjs");

async function waitForFile(file, child, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
    if (child.exitCode !== null) throw new Error(`Linux Host exited before publishing driver.json: ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function exchange(record, requests) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: record.host, port: record.port });
    const framer = new ContentLengthFramer();
    const responses = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for Linux Host RPC responses."));
    }, 3000);
    socket.once("connect", () => {
      for (const request of requests) socket.write(encodeContentLengthFrame(request));
    });
    socket.on("data", (chunk) => {
      try {
        for (const frame of framer.push(chunk)) responses.push(JSON.parse(frame.toString("utf8")));
        if (responses.length === requests.length) {
          clearTimeout(timer);
          socket.end();
          resolve(responses);
        }
      } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("Linux Host requires token initialization and reports unavailable Wayland capability honestly", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-linux-host-rpc-"));
  const runtime = path.join(parent, "driver");
  const environment = { ...process.env };
  delete environment.DISPLAY;
  environment.WAYLAND_DISPLAY = "wayland-test";
  environment.EMACS_OPERATOR_DRIVER_RUNTIME_DIR = runtime;
  environment.EMACS_OPERATOR_LINUX_BACKEND = "auto";
  const child = spawn(process.execPath, [hostPath], { env: environment, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const recordFile = path.join(runtime, "driver.json");
    await waitForFile(recordFile, child);
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    const token = fs.readFileSync(record.token_file, "utf8").trim();

    const unauthenticated = await exchange(record, [
      { jsonrpc: "2.0", id: 1, method: "driver.permissions", params: {} }
    ]);
    assert.equal(unauthenticated[0].error.data.code, "E_AUTH_FAILED");

    const wrong = await exchange(record, [
      { jsonrpc: "2.0", id: 2, method: "driver.initialize", params: { token: "0".repeat(64) } }
    ]);
    assert.equal(wrong[0].error.data.code, "E_AUTH_FAILED");

    const accepted = await exchange(record, [
      { jsonrpc: "2.0", id: 3, method: "driver.initialize", params: { token } },
      { jsonrpc: "2.0", id: 4, method: "driver.permissions", params: {} },
      { jsonrpc: "2.0", id: 5, method: "driver.unknown", params: {} }
    ]);
    assert.equal(accepted[0].result.backend, "unavailable");
    assert.equal(accepted[0].result.display_server, "wayland");
    assert.equal(accepted[0].result.native_keyboard, false);
    assert.equal(accepted[1].result[0].granted, false);
    assert.equal(accepted[2].error.data.code, "E_INVALID_ARGUMENT");
  } finally {
    await stop(child);
    fs.rmSync(parent, { recursive: true, force: true });
  }
  assert.match(stderr, /backend=unavailable/);
});
