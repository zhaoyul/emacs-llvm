import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/sessions/sessionManager.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { OperatorError } from "../../protocol/src/errors.js";

function makeSession(manager: SessionManager, profile = "workspace_edit") {
  return manager.open({
    instanceId: "emacs-1",
    defaultChannel: "semantic",
    permissionProfile: profile,
    target: { buffer_id: "buf-1", buffer_name: "x.el", file: "/workspace/x.el", project_root: "/workspace", major_mode: "emacs-lisp-mode" },
    capabilities: { channels: { semantic: true, internal_keys: true, native_keys: false }, features: {} },
    stateSeqAtOpen: 1
  });
}

test("only one session can own mutation lease per Emacs instance", () => {
  const manager = new SessionManager();
  const one = makeSession(manager);
  const two = makeSession(manager);
  manager.acquireMutation(one.sessionId);
  assert.throws(() => manager.acquireMutation(two.sessionId), (error: unknown) => error instanceof OperatorError && error.code === "E_MUTATION_LOCKED");
  manager.close(one.sessionId);
  assert.doesNotThrow(() => manager.acquireMutation(two.sessionId));
});

test("workspace policy blocks outside paths and native key injection", () => {
  const manager = new SessionManager();
  const session = makeSession(manager);
  const policy = new PolicyEngine();
  assert.doesNotThrow(() => policy.assertFilePath(session, "/workspace/src/y.el"));
  assert.throws(() => policy.assertFilePath(session, "/tmp/y.el"), /outside the authorized workspace/);
  assert.throws(() => policy.assertChannel(session, "native_keys"), /unavailable/);
});

test("expired sessions are rejected and release their mutation lease", () => {
  let now = 1_000;
  const manager = new SessionManager(1, () => now);
  const expired = makeSession(manager);
  manager.acquireMutation(expired.sessionId);
  now += 2;
  assert.throws(
    () => manager.get(expired.sessionId),
    (error: unknown) => error instanceof OperatorError && error.code === "E_SESSION_EXPIRED"
  );
  const replacement = makeSession(manager);
  assert.doesNotThrow(() => manager.acquireMutation(replacement.sessionId));
});

test("read_only profile rejects mutations and capture", () => {
  const manager = new SessionManager();
  const session = makeSession(manager, "read_only");
  const policy = new PolicyEngine();
  assert.throws(() => policy.assertMutation(session), (error: unknown) => error instanceof OperatorError && error.code === "E_POLICY_DENIED");
  assert.throws(() => policy.assertCapture(session), (error: unknown) => error instanceof OperatorError && error.code === "E_POLICY_DENIED");
});
