import test from "node:test";
import assert from "node:assert/strict";
import { validateAndEncodeEvents } from "../src/x11-backend.mjs";

test("X11 event plan encodes key, modifiers, and Unicode text without raw payload leakage", () => {
  const plan = validateAndEncodeEvents([
    { kind: "key_press", key: "x", modifiers: ["control"], repeat_count: 2 },
    { kind: "text", text: "你好" }
  ]);
  assert.equal(plan.split("\n").filter(Boolean).length, 2);
  assert.equal(plan.includes("你好"), false);
  assert.match(plan, /^key_press\t/);
});

test("X11 event plan rejects unbalanced or unsupported state", () => {
  assert.throws(() => validateAndEncodeEvents([{ kind: "key_down", key: "a" }]), /unbalanced/);
  assert.throws(() => validateAndEncodeEvents([{ kind: "key_up", key: "a" }]), /no matching/);
  assert.throws(() => validateAndEncodeEvents([{ kind: "key_press", key: "a", modifiers: ["fn"] }]), /unsupported/);
  assert.throws(() => validateAndEncodeEvents([{ kind: "key_down", key: "a", repeat_count: 2 }]), /cannot be repeated/);
  assert.throws(() => validateAndEncodeEvents([{ kind: "text", text: "a\0b" }]), /NUL/);
});
