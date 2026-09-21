import test from "node:test";
import assert from "node:assert/strict";
import { VerificationTicketManager } from "../src/verificationTickets.js";

const attempt = (completed = false) => ({ completed, condition: completed ? null : "error", metadata: { source_sha256: "a" } });

test("verification tickets are session-bound and append attempts", () => {
  let now = 1000;
  const manager = new VerificationTicketManager(1000, 10, () => now);
  const ticket = manager.create({ sessionId: "s1", adapter: "cider", operation: "eval_defun", timeoutMs: 1000, maxAttempts: 3, sideEffectRisk: "low", allowRiskyRerun: false, attempts: [attempt()] });
  assert.equal(manager.get(ticket.ticketId, "s1").attempts.length, 1);
  assert.throws(() => manager.get(ticket.ticketId, "s2"));
  manager.append(ticket.ticketId, "s1", attempt(true));
  assert.equal(manager.get(ticket.ticketId, "s1").attempts.length, 2);
  manager.close(ticket.ticketId, "s1");
  assert.throws(() => manager.get(ticket.ticketId, "s1"));
});

test("verification tickets expire deterministically", () => {
  let now = 1000;
  const manager = new VerificationTicketManager(100, 10, () => now);
  const ticket = manager.create({ sessionId: "s", adapter: null, operation: "eval_defun", timeoutMs: 1000, maxAttempts: 3, sideEffectRisk: "unknown", allowRiskyRerun: false, attempts: [attempt()] });
  now = 1101;
  assert.throws(() => manager.get(ticket.ticketId, "s"));
});
