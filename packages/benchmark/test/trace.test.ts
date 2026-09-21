import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { convertAuditJsonlToTrace, readTraceFile, sanitizeTraceEvents, summarizeTrace } from "../src/trace.js";
import { temporaryDirectory } from "./helpers.js";

test("trace sanitizer removes unsupported fields and summarizes behavior", () => {
  const events = sanitizeTraceEvents([
    { at_ms: 1, kind: "tool_call", tool: "emacs_edit", mutation: true, secret: "discard" },
    { at_ms: 2, kind: "tool_result", tool: "emacs_edit", ok: false, error_code: "E_STATE_CONFLICT" },
    { at_ms: 3, kind: "rollback", tool: "emacs_rollback", ok: true },
    { at_ms: -1, kind: "note" },
    { at_ms: 4, kind: "unsupported" }
  ]);
  assert.equal(events.length, 3);
  assert.equal((events[0] as any).secret, undefined);
  const summary = summarizeTrace(events, { input_tokens: 10, output_tokens: 4 });
  assert.equal(summary.tool_calls, 1);
  assert.equal(summary.mutations, 1);
  assert.equal(summary.rollbacks, 1);
  assert.equal(summary.tool_errors, 1);
  assert.equal(summary.input_tokens, 10);
});

test("trace reader rejects invalid JSON and converts audit JSONL", () => {
  const root = temporaryDirectory();
  try {
    const file = path.join(root, "trace.jsonl");
    fs.writeFileSync(file, "{bad}\n");
    assert.throws(() => readTraceFile(file), /not valid JSON/u);
    const audit = path.join(root, "audit.jsonl");
    fs.writeFileSync(audit, `${JSON.stringify({ at_ms: 5, tool: "emacs_edit", operation: "replace", mutation: true, ok: true })}\n`);
    const events = convertAuditJsonlToTrace(audit);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, "tool_call");
    assert.equal(events[1]?.kind, "tool_result");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
