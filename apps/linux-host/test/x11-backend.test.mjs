import assert from "node:assert/strict";
import test from "node:test";
import { LinuxDriverError, validateAndEncodeEvents } from "../src/x11-backend.mjs";

test("event planner emits bounded canonical records", () => {
  const result = validateAndEncodeEvents([
    { kind: "key_press", key: "a", code: "KeyA", modifiers: ["control"], delay_after_milliseconds: 10 },
    { kind: "text", text: "Az1" }
  ]);
  const rows = result.trim().split("\n");
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^key_press\t/);
  assert.match(rows[1], /^text\t/);
});

test("event planner rejects unbalanced keys, duplicate modifiers and payload floods", () => {
  assert.throws(
    () => validateAndEncodeEvents([{ kind: "key_down", key: "a", code: "KeyA" }]),
    (error) => error instanceof LinuxDriverError && /unbalanced/i.test(error.message)
  );
  assert.throws(
    () => validateAndEncodeEvents([{ kind: "key_press", key: "a", modifiers: ["control", "control"] }]),
    /duplicate/i
  );
  assert.throws(
    () => validateAndEncodeEvents([{ kind: "text", text: "x".repeat(65_537) }]),
    /64 KiB/i
  );
  assert.throws(
    () => validateAndEncodeEvents([{ kind: "key_press", key: "a", modifiers: ["alt", "meta"] }]),
    /alias-equivalent/i
  );
  assert.throws(
    () => validateAndEncodeEvents([{ kind: "text", text: "" }]),
    /no effective events/i
  );
  assert.throws(
    () => validateAndEncodeEvents([{ kind: "key_press", key: "x".repeat(129) }]),
    /128 UTF-8 bytes/i
  );
});
