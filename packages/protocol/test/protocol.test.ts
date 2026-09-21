import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { failureEnvelope, OperatorError, successEnvelope, validateInternalKeySteps } from "../src/index.js";

const schemas = ["tool-envelope.schema.json", "precondition.schema.json", "key-sequence.schema.json", "instance-record.schema.json"];

test("protocol JSON schema files parse and declare a schema", () => {
  for (const name of schemas) {
    const file = path.join(process.cwd(), "packages", "protocol", "schemas", name);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(typeof parsed.$schema, "string");
  }
});

test("success envelope preserves result and state", () => {
  const envelope = successEnvelope({
    requestId: "req_1",
    auditId: "aud_1",
    sessionId: "ses_1",
    stateBefore: { state_seq: 1, buffer_tick: 2 },
    stateAfter: { state_seq: 2, buffer_tick: 3 },
    result: { value: 42 }
  });
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.result, { value: 42 });
  assert.equal(envelope.state_after?.buffer_tick, 3);
});

test("failure envelope maps stable error metadata", () => {
  const envelope = failureEnvelope({
    requestId: "req_2",
    auditId: "aud_2",
    error: new OperatorError("E_STATE_CONFLICT", "changed", { expected: 1, actual: 2 })
  });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "E_STATE_CONFLICT");
  assert.equal(envelope.error.retryable, true);
  assert.equal(envelope.error.category, 409);
});

test("internal key steps validate Unicode text and structured key presses", () => {
  const steps = validateInternalKeySteps([
    { kind: "keys", value: "C-M-f" },
    { kind: "text", value: "中文λ" },
    { kind: "event", event: { kind: "key_press", key: "x", modifiers: ["control", "meta"] } },
    { kind: "expect", condition: { major_mode: "emacs-lisp-mode" } }
  ]);
  assert.equal(steps.length, 4);
  assert.throws(() => validateInternalKeySteps([{ kind: "event", event: { kind: "bogus" } }]), /Invalid key event kind/);
});
