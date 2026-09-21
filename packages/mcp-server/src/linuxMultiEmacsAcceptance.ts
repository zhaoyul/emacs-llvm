import fs from "node:fs";
import path from "node:path";
import { ToolRouter } from "./tools/toolRouter.js";

interface Gate { name: string; status: "pass" | "fail"; details?: string }
const gates: Gate[] = [];
const reportPath = process.env.EMACS_OPERATOR_LINUX_MULTI_EMACS_REPORT;

function pass(name: string, details?: string): void {
  gates.push({ name, status: "pass", ...(details ? { details } : {}) });
  process.stdout.write(`PASS  ${name}${details ? `: ${details}` : ""}\n`);
}
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function unwrap(envelope: Awaited<ReturnType<ToolRouter["call"]>>, name: string): Record<string, any> {
  if (!envelope.ok) throw new Error(`${name} failed: ${envelope.error.code}: ${envelope.error.message}`);
  return envelope.result as Record<string, any>;
}
async function readBuffer(router: ToolRouter, sessionId: string): Promise<string> {
  const observed = unwrap(await router.call("emacs_observe", { session_id: sessionId, scope: ["compact"] }), "emacs_observe");
  const buffer = observed.buffer && typeof observed.buffer === "object" ? observed.buffer as Record<string, unknown> : {};
  const pointMin = typeof buffer.point_min === "number" ? Math.floor(buffer.point_min) : 1;
  const pointMax = typeof buffer.point_max === "number" ? Math.floor(buffer.point_max) : undefined;
  if (pointMax === undefined) throw new Error("Observation did not expose point_max.");
  const read = unwrap(await router.call("emacs_read", { session_id: sessionId, start: pointMin, end: pointMax, max_chars: 65536 }), "emacs_read");
  if (typeof read.text !== "string") throw new Error("emacs_read did not return text.");
  return read.text;
}
function writeReport(ok: boolean, error?: unknown): void {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    schema_version: "1.0", platform: "linux", suite: "linux-multi-emacs-v1", completed_at: new Date().toISOString(), ok, gates,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
  }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const primaryPid = Number(requireEnv("EMACS_OPERATOR_LINUX_PRIMARY_EMACS_PID"));
  const secondaryPid = Number(requireEnv("EMACS_OPERATOR_LINUX_SECONDARY_EMACS_PID"));
  const primaryBuffer = requireEnv("EMACS_OPERATOR_LINUX_PRIMARY_EMACS_BUFFER");
  const secondaryBuffer = requireEnv("EMACS_OPERATOR_LINUX_SECONDARY_EMACS_BUFFER");
  const primaryMarker = requireEnv("EMACS_OPERATOR_LINUX_PRIMARY_EMACS_MARKER");
  const secondaryMarker = requireEnv("EMACS_OPERATOR_LINUX_SECONDARY_EMACS_MARKER");
  if (!Number.isInteger(primaryPid) || !Number.isInteger(secondaryPid) || primaryPid <= 0 || secondaryPid <= 0 || primaryPid === secondaryPid) {
    throw new Error("Primary and secondary Emacs PIDs must be distinct positive integers.");
  }

  const router = new ToolRouter();
  const sessions: string[] = [];
  try {
    const instancesResult = unwrap(await router.call("emacs_instances", {}), "emacs_instances");
    const live = (Array.isArray(instancesResult.instances) ? instancesResult.instances : [])
      .filter((item: any) => item && item.stale !== true && item.process_alive !== false);
    const primary = live.find((item: any) => Number(item.pid) === primaryPid);
    const secondary = live.find((item: any) => Number(item.pid) === secondaryPid);
    if (!primary || !secondary || typeof primary.instance_id !== "string" || typeof secondary.instance_id !== "string") {
      throw new Error(`Did not discover both live Emacs instances. live=${JSON.stringify(live.map((item: any) => ({ instance_id: item.instance_id, pid: item.pid })))}`);
    }
    if (primary.instance_id === secondary.instance_id) throw new Error("Two Emacs processes published the same instance_id.");
    pass("two live bridge instances", `${primary.instance_id}/${primaryPid}, ${secondary.instance_id}/${secondaryPid}`);

    const ambiguous = await router.call("emacs_session_open", {
      selector: { buffer_name: primaryBuffer }, permission_profile: "trusted_local", default_channel: "semantic"
    });
    if (ambiguous.ok || ambiguous.error.code !== "E_INVALID_ARGUMENT") {
      throw new Error("Session open without instance_id did not fail closed when multiple Emacs instances were live.");
    }
    pass("ambiguous selector rejection", ambiguous.error.code);

    const primaryOpened = unwrap(await router.call("emacs_session_open", {
      selector: { instance_id: primary.instance_id, buffer_name: primaryBuffer }, permission_profile: "trusted_local", default_channel: "semantic"
    }), "primary session open");
    const secondaryOpened = unwrap(await router.call("emacs_session_open", {
      selector: { instance_id: secondary.instance_id, buffer_name: secondaryBuffer }, permission_profile: "trusted_local", default_channel: "semantic"
    }), "secondary session open");
    const primarySession = String(primaryOpened.session.sessionId);
    const secondarySession = String(secondaryOpened.session.sessionId);
    sessions.push(primarySession, secondarySession);

    const primaryTarget = primaryOpened.target as Record<string, unknown>;
    const secondaryTarget = secondaryOpened.target as Record<string, unknown>;
    if (!primaryTarget.native_window_identifier || !secondaryTarget.native_window_identifier) throw new Error("Both real Emacs sessions must expose native X11 window identifiers.");
    if (primaryTarget.native_window_identifier === secondaryTarget.native_window_identifier) throw new Error("Two Emacs processes resolved to the same native window identifier.");
    pass("distinct native GUI identities", `${String(primaryTarget.native_window_identifier)} != ${String(secondaryTarget.native_window_identifier)}`);

    const primaryBefore = await readBuffer(router, primarySession);
    const secondaryBefore = await readBuffer(router, secondarySession);
    if (!primaryBefore.includes(primaryMarker)) throw new Error(`Primary marker is missing: ${JSON.stringify(primaryBefore)}`);
    if (!secondaryBefore.includes(secondaryMarker)) throw new Error(`Secondary marker is missing: ${JSON.stringify(secondaryBefore)}`);
    pass("explicit instance read routing", "each session observed only its expected marker");

    // Semantic mutation goes only to the explicitly selected secondary process.
    await router.call("emacs_navigate", { session_id: secondarySession, operation: "buffer_end" });
    const edited = await router.call("emacs_edit", { session_id: secondarySession, operation: "insert", text: "ROUTED-SECONDARY\n" });
    if (!edited.ok) throw new Error(`Secondary edit failed: ${edited.error.code}: ${edited.error.message}`);
    const primaryAfter = await readBuffer(router, primarySession);
    const secondaryAfter = await readBuffer(router, secondarySession);
    if (primaryAfter !== primaryBefore) throw new Error("Mutation routed to the secondary instance changed the primary buffer.");
    if (!secondaryAfter.endsWith("ROUTED-SECONDARY\n")) throw new Error("Secondary mutation did not reach the selected instance.");
    pass("semantic mutation isolation", "secondary changed, primary byte-for-byte unchanged");

    // Internal key execution is also instance-bound and does not need desktop
    // foreground focus. Move point to beginning only in secondary and insert a
    // marker via the real Emacs command loop.
    const keys = await router.call("emacs_key_sequence", {
      session_id: secondarySession,
      channel: "internal_keys",
      steps: [
        { kind: "keys", value: "C-a" },
        { kind: "text", value: "INTERNAL-SECONDARY " }
      ]
    });
    if (!keys.ok) throw new Error(`Secondary internal key sequence failed: ${keys.error.code}: ${keys.error.message}`);
    const primaryAfterKeys = await readBuffer(router, primarySession);
    const secondaryAfterKeys = await readBuffer(router, secondarySession);
    if (primaryAfterKeys !== primaryBefore) throw new Error("Internal key execution on secondary changed the primary instance.");
    if (!secondaryAfterKeys.includes("INTERNAL-SECONDARY")) throw new Error("Internal key execution did not reach the secondary instance.");
    pass("internal-key instance isolation", "command-loop mutation stayed on the selected Emacs process");
  } finally {
    for (const sessionId of sessions.reverse()) await router.call("emacs_session_close", { session_id: sessionId }).catch(() => undefined);
    router.bridges.closeAll();
    router.driver.close();
  }
}

main().then(() => writeReport(true)).catch((error) => {
  gates.push({ name: "linux multi-Emacs acceptance", status: "fail", details: error instanceof Error ? error.message : String(error) });
  writeReport(false, error);
  process.stderr.write(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
