import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverInstances, readInstanceToken } from "../src/runtime.js";

test("discovery reads a live instance record and secured token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-test-"));
  const tokenFile = path.join(dir, "token-test");
  fs.writeFileSync(tokenFile, `${"a".repeat(64)}\n`, { mode: 0o600 });
  const record = {
    protocol_version: "1.0",
    instance_id: "emacs-test",
    pid: process.pid,
    host: "127.0.0.1",
    port: 45678,
    token_file: tokenFile,
    emacs_version: "test",
    system_type: process.platform,
    window_system: null,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dir, "instance-emacs-test.json"), JSON.stringify(record), { mode: 0o600 });
  const instances = discoverInstances({ runtimeDir: dir });
  assert.equal(instances.length, 1);
  assert.equal(instances[0]?.stale, false);
  assert.equal(readInstanceToken(record), "a".repeat(64));
  fs.rmSync(dir, { recursive: true, force: true });
});
