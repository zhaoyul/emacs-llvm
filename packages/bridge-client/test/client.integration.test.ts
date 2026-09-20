import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BridgeClient } from "../src/client.js";
import { FakeEmacsBridge } from "../../test-harness/src/fakeBridge.js";

test("BridgeClient authenticates and exchanges framed JSON-RPC over real loopback TCP", async () => {
  const fake = new FakeEmacsBridge();
  await fake.start();
  try {
    const record = JSON.parse(fs.readFileSync(fake.instanceFile, "utf8"));
    const client = new BridgeClient(record);
    const initialized = await client.connectAndInitialize();
    assert.equal((initialized.channels as any).internal_keys, true);
    const ping = await client.request<any>("ping", {});
    assert.equal(ping.pong, true);
    client.close();
  } finally {
    await fake.stop();
  }
});
