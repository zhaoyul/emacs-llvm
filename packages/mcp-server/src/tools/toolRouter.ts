import crypto from "node:crypto";
import { applyUnifiedDiff, asOperatorError, EMACS_OPERATOR_VERSION, failureEnvelope, OperatorError, successEnvelope, validateInternalKeySteps, validatePrecondition, assertObject, requiredString } from "../../../protocol/src/index.js";
import type { AuditEntry, EmacsSession, ExecutionChannel, ResolvedTarget, SessionCapabilities, StateSummary, ToolEnvelope } from "../../../protocol/src/index.js";
import { BridgeRegistry } from "../bridgeRegistry.js";
import { SessionManager } from "../sessions/sessionManager.js";
import { PolicyEngine } from "../policy/policyEngine.js";
import { AuditLog } from "../audit/auditLog.js";
import { IdempotencyCache } from "../idempotency.js";
import { AutoPlatformDriver, type PlatformDriver } from "../drivers/platformDriver.js";
import { consumeCapturePNG } from "../drivers/captureFiles.js";
import { VerificationTicketManager, type VerificationAttempt } from "../verificationTickets.js";
import { prepareSymbolRename } from "../../../refactor-intelligence/src/symbol-semantics.js";

function snakeTarget(session: EmacsSession): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  if (session.target.frameId) target.frame_id = session.target.frameId;
  if (session.target.windowId) target.window_id = session.target.windowId;
  if (session.target.bufferId) target.buffer_id = session.target.bufferId;
  if (session.target.projectRoot) target.project_root = session.target.projectRoot;
  if (session.target.file) target.file = session.target.file;
  return target;
}


function nativeTarget(session: EmacsSession, pid: number, overrides: { window_title?: unknown; window_identifier?: unknown } = {}): { pid: number; window_title?: string; window_identifier?: string } {
  const target: { pid: number; window_title?: string; window_identifier?: string } = { pid };
  const title = typeof overrides.window_title === "string" && overrides.window_title.length > 0
    ? overrides.window_title
    : session.target.frameTitle;
  const identifier = typeof overrides.window_identifier === "string" && overrides.window_identifier.length > 0
    ? overrides.window_identifier
    : session.target.nativeWindowIdentifier;
  if (title) target.window_title = title;
  if (identifier) target.window_identifier = identifier;
  return target;
}

function policyContext(session: EmacsSession): Record<string, unknown> {
  return {
    profile: session.permissionProfile,
    project_root: session.target.projectRoot ?? null
  };
}


function asRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeStructuredEvaluation(response: Record<string, unknown>): VerificationAttempt {
  const dispatch = asRecordValue(response.evaluation);
  const result = asRecordValue(dispatch.result ?? dispatch);
  return {
    ...result,
    adapter: typeof dispatch.adapter === "string" ? dispatch.adapter : (typeof result.adapter === "string" ? result.adapter : null),
    completed: result.completed === true,
    metadata: asRecordValue(result.metadata)
  };
}

interface AnalysisSourceFingerprint {
  sourceSha256: string | null;
  sourceStart: number | null;
  sourceBounds: [number, number] | null;
}

function sourceStartFromMetadata(metadata: Record<string, unknown>): number | null {
  if (typeof metadata.source_start === "number" && Number.isFinite(metadata.source_start)) {
    return metadata.source_start;
  }
  const bounds = metadata.source_bounds;
  if (Array.isArray(bounds) && bounds.length === 2 && typeof bounds[0] === "number" && Number.isFinite(bounds[0])) {
    return bounds[0];
  }
  return null;
}

function analysisFingerprint(response: Record<string, unknown>): AnalysisSourceFingerprint {
  const level1 = asRecordValue(response.analysis);
  const level2 = asRecordValue(level1.result ?? level1.analysis ?? level1);
  const level3 = asRecordValue(level2.analysis ?? level2);
  const rawBounds = level3.source_bounds;
  const sourceBounds: [number, number] | null =
    Array.isArray(rawBounds) && rawBounds.length === 2 &&
    typeof rawBounds[0] === "number" && Number.isFinite(rawBounds[0]) &&
    typeof rawBounds[1] === "number" && Number.isFinite(rawBounds[1])
      ? [rawBounds[0], rawBounds[1]]
      : null;
  return {
    sourceSha256: typeof level3.source_sha256 === "string" ? level3.source_sha256 : null,
    sourceStart: typeof level3.source_start === "number" && Number.isFinite(level3.source_start)
      ? level3.source_start
      : sourceBounds?.[0] ?? null,
    sourceBounds
  };
}

function inferProjectRenameLanguage(args: Record<string, unknown>, observed: Record<string, unknown>): "generic" | "elisp" | "clojure" | "common_lisp" {
  if (typeof args.language === "string") {
    if (["generic", "elisp", "clojure", "common_lisp"].includes(args.language)) return args.language as "generic" | "elisp" | "clojure" | "common_lisp";
    throw new OperatorError("E_INVALID_ARGUMENT", "Unsupported project rename language.", { language: args.language });
  }
  const buffer = asRecordValue(observed.buffer);
  const majorMode = typeof buffer.major_mode === "string" ? buffer.major_mode : "";
  if (majorMode === "emacs-lisp-mode" || majorMode === "lisp-interaction-mode") return "elisp";
  if (["clojure-mode", "clojurescript-mode", "clojurec-mode"].includes(majorMode)) return "clojure";
  if (["lisp-mode", "common-lisp-mode", "sly-mrepl-mode", "slime-repl-mode"].includes(majorMode)) return "common_lisp";
  return "generic";
}

function prepareProjectRenameSymbols(args: Record<string, unknown>, observed: Record<string, unknown>): Record<string, unknown> {
  const oldSymbol = requiredString(args, "old_symbol");
  const requestedNewSymbol = requiredString(args, "new_symbol");
  const language = inferProjectRenameLanguage(args, observed);
  const qualificationPolicy = typeof args.qualification_policy === "string" ? args.qualification_policy : undefined;
  try {
    const prepared = (prepareSymbolRename as unknown as (input: Record<string, unknown>) => Record<string, unknown>)({
      oldSymbol,
      newSymbol: requestedNewSymbol,
      language,
      ...(qualificationPolicy ? { qualificationPolicy } : {})
    });
    return {
      old_symbol: oldSymbol,
      requested_new_symbol: requestedNewSymbol,
      new_symbol: prepared.effective_new_symbol,
      language: prepared.language,
      qualification_policy: prepared.qualification_policy,
      symbol_semantics: prepared
    };
  } catch (error) {
    const candidate = error as Error & { code?: unknown; details?: unknown };
    throw new OperatorError("E_INVALID_ARGUMENT", candidate.message, {
      semantic_code: typeof candidate.code === "string" ? candidate.code : "E_SYMBOL_SEMANTICS",
      ...(candidate.details && typeof candidate.details === "object" && !Array.isArray(candidate.details)
        ? { semantic_details: candidate.details as Record<string, unknown> }
        : {}),
      language,
      qualification_policy: qualificationPolicy ?? null,
      old_symbol: oldSymbol,
      requested_new_symbol: requestedNewSymbol
    });
  }
}

function stateSummary(observed: unknown): StateSummary | undefined {
  if (!observed || typeof observed !== "object") return undefined;
  const value = observed as Record<string, unknown>;
  const buffer = value.buffer && typeof value.buffer === "object" ? value.buffer as Record<string, unknown> : undefined;
  const cursor = value.cursor && typeof value.cursor === "object" ? value.cursor as Record<string, unknown> : undefined;
  const out: StateSummary = {};
  if (typeof value.state_seq === "number") out.state_seq = value.state_seq;
  if (buffer && typeof buffer.buffer_tick === "number") out.buffer_tick = buffer.buffer_tick;
  if (buffer && typeof buffer.id === "string") out.buffer_id = buffer.id;
  if (buffer && typeof buffer.major_mode === "string") out.major_mode = buffer.major_mode;
  if (cursor && typeof cursor.point === "number") out.point = cursor.point;
  return out;
}

export class ToolRouter {
  readonly sessions = new SessionManager();
  readonly policy = new PolicyEngine();
  readonly audit = new AuditLog();
  readonly bridges = new BridgeRegistry();
  readonly driver: PlatformDriver;
  private readonly idempotency = new IdempotencyCache<ToolEnvelope<unknown>>();
  private readonly verificationTickets = new VerificationTicketManager();

  constructor(driver: PlatformDriver = new AutoPlatformDriver()) {
    this.driver = driver;
  }

  async call(name: string, rawArguments: unknown): Promise<ToolEnvelope<unknown>> {
    const started = Date.now();
    const args = rawArguments === undefined ? {} : rawArguments;
    assertObject(args, "arguments");
    const requestId = typeof args.request_id === "string" && args.request_id ? args.request_id : `req_${crypto.randomUUID()}`;
    const cached = this.idempotency.get(`${name}:${requestId}`);
    if (cached) return cached;
    const auditId = this.audit.newId();
    const sessionId = typeof args.session_id === "string" ? args.session_id : undefined;
    let before: StateSummary | undefined;
    let after: StateSummary | undefined;
    let mutation = false;
    let instanceId: string | undefined;
    try {
      const result = await this.dispatch(name, args, {
        setBefore: (value) => { before = value; },
        setAfter: (value) => { after = value; },
        markMutation: () => { mutation = true; },
        setInstance: (value) => { instanceId = value; }
      });
      const envelope = successEnvelope({ requestId, auditId, result, ...(sessionId ? { sessionId } : {}), ...(before ? { stateBefore: before } : {}), ...(after ? { stateAfter: after } : {}) });
      this.audit.append(this.auditEntry({ auditId, requestId, sessionId, instanceId, tool: name, mutation, ok: true, durationMs: Date.now() - started, before, after }));
      this.idempotency.set(`${name}:${requestId}`, envelope);
      return envelope;
    } catch (error) {
      const op = asOperatorError(error);
      const envelope = failureEnvelope({ requestId, auditId, error: op, ...(sessionId ? { sessionId } : {}) });
      this.audit.append(this.auditEntry({ auditId, requestId, sessionId, instanceId, tool: name, mutation, ok: false, errorCode: op.code, durationMs: Date.now() - started, before, after }));
      this.idempotency.set(`${name}:${requestId}`, envelope);
      return envelope;
    }
  }

  private auditEntry(input: { auditId: string; requestId: string; sessionId?: string | undefined; instanceId?: string | undefined; tool: string; mutation: boolean; ok: boolean; errorCode?: string | undefined; durationMs: number; before?: StateSummary | undefined; after?: StateSummary | undefined }): AuditEntry {
    const out: AuditEntry = {
      audit_id: input.auditId,
      request_id: input.requestId,
      timestamp: new Date().toISOString(),
      tool: input.tool,
      mutation: input.mutation,
      ok: input.ok,
      duration_ms: input.durationMs
    };
    if (input.sessionId) out.session_id = input.sessionId;
    if (input.instanceId) out.instance_id = input.instanceId;
    if (input.errorCode) out.error_code = input.errorCode;
    if (input.before) out.state_before = input.before;
    if (input.after) out.state_after = input.after;
    return out;
  }

  private async dispatch(name: string, args: Record<string, unknown>, hooks: { setBefore(v: StateSummary | undefined): void; setAfter(v: StateSummary | undefined): void; markMutation(): void; setInstance(v: string): void }): Promise<unknown> {
    if (name === "emacs_health") {
      const driver = await this.driver.initialize();
      return {
        status: "ok",
        version: EMACS_OPERATOR_VERSION,
        implemented_phases: [0, 1, 2, 3, 4, 5, 6, 7, 8],
        source_phases: [0, 1, 2, 3, 4, 5, 6, 7, 8],
        verification: {
          typescript_runtime: true,
          emacs_runtime_required: true,
          macos_native_runtime_required: true,
          linux_native_runtime_required: true
        },
        channels: { semantic: true, internal_keys: true, native_keys: driver.connected && driver.native_keyboard },
        native_driver: driver
      };
    }
    if (name === "emacs_instances") {
      const driver = await this.driver.initialize();
      return {
        instances: this.bridges.discover().map((item) => ({ ...item.record, stale: item.stale, process_alive: item.process_alive })),
        native_driver: driver
      };
    }
    if (name === "emacs_session_open") return this.openSession(args, hooks);
    if (name === "emacs_session_close") {
      const id = requiredString(args, "session_id");
      const session = this.sessions.get(id);
      hooks.setInstance(session.instanceId);
      return { closed: this.sessions.close(id) };
    }

    const session = this.sessions.get(requiredString(args, "session_id"));
    hooks.setInstance(session.instanceId);
    const client = await this.bridges.client(session.instanceId);

    if (name === "emacs_observe") {
      const result = await client.request<Record<string, unknown>>("state.observe", {
        target: snakeTarget(session),
        scope: args.scope ?? ["compact", "context"],
        around_chars: typeof args.around_chars === "number" ? Math.min(16_384, Math.max(0, args.around_chars)) : 1600,
        since_state_seq: args.since_state_seq ?? null
      });
      hooks.setAfter(stateSummary(result));
      return result;
    }

    if (name === "emacs_read") {
      const observed = await this.observeCompact(client, session);
      const buffer = observed.buffer && typeof observed.buffer === "object" ? observed.buffer as Record<string, unknown> : {};
      const pointMin = typeof buffer.point_min === "number" ? Math.floor(buffer.point_min) : 1;
      const pointMax = typeof buffer.point_max === "number" ? Math.floor(buffer.point_max)
        : typeof buffer.size === "number" ? pointMin + Math.floor(buffer.size) : undefined;
      if (pointMax === undefined) throw new OperatorError("E_INTERNAL", "Bridge observation did not provide buffer bounds.");
      const maxChars = typeof args.max_chars === "number" ? Math.min(262_144, Math.max(1, Math.floor(args.max_chars))) : 32_768;
      const start = typeof args.start === "number" ? Math.floor(args.start) : pointMin;
      const requestedEnd = typeof args.end === "number" ? Math.floor(args.end) : pointMax;
      if (start < pointMin || start > pointMax) throw new OperatorError("E_INVALID_ARGUMENT", "Read start is outside the accessible buffer.", { start, point_min: pointMin, point_max: pointMax });
      if (requestedEnd < start || requestedEnd > pointMax) throw new OperatorError("E_INVALID_ARGUMENT", "Read end is outside the accessible buffer or precedes start.", { start, end: requestedEnd, point_min: pointMin, point_max: pointMax });
      const end = Math.min(requestedEnd, start + maxChars);
      const resource = await client.request<Record<string, unknown>>("resource.read", { target: snakeTarget(session), start, end });
      const actualEnd = typeof resource.end === "number" ? resource.end : end;
      hooks.setAfter(stateSummary(observed));
      return {
        ...resource,
        point_min: pointMin,
        point_max: pointMax,
        requested_end: requestedEnd,
        truncated: actualEnd < requestedEnd,
        next_start: actualEnd < requestedEnd ? actualEnd : null
      };
    }

    if (name === "emacs_navigate") {
      validatePrecondition(args.precondition);
      const before = await this.observeCompact(client, session);
      hooks.setBefore(stateSummary(before));
      const result = await client.request<Record<string, unknown>>("navigation.execute", {
        target: snakeTarget(session),
        operation: requiredString(args, "operation"),
        position: args.position ?? null,
        line: args.line ?? null,
        query: args.query ?? null,
        regex: args.regex === true,
        case_sensitive: args.case_sensitive === true,
        count: args.count ?? 1,
        bound: args.bound ?? null,
        precondition: args.precondition ?? null
      });
      const afterObserved = await this.observeCompact(client, session);
      hooks.setAfter(stateSummary(afterObserved));
      return { execution: result, observed: afterObserved };
    }

    if (name === "emacs_capabilities") {
      return client.request("capabilities.query", {
        target: snakeTarget(session),
        operation: requiredString(args, "operation"),
        key: args.key ?? null,
        command: args.command ?? null,
        feature: args.feature ?? null,
        adapter: args.adapter ?? null
      });
    }

    if (name === "emacs_validate") {
      const observed = await this.observeCompact(client, session);
      hooks.setBefore(stateSummary(observed));
      const result = await client.request<Record<string, unknown>>("adapter.validate", {
        target: snakeTarget(session),
        adapter: typeof args.adapter === "string" && args.adapter.length > 0 ? args.adapter : null,
        options: args.options && typeof args.options === "object" ? args.options : {}
      });
      const afterObserved = await this.observeCompact(client, session);
      hooks.setAfter(stateSummary(afterObserved));
      return { validation: result, observed: afterObserved };
    }

    if (name === "emacs_wait") {
      const timeout = typeof args.timeout_ms === "number" ? Math.min(10_000, Math.max(1, args.timeout_ms)) : 5_000;
      return client.request("wait.condition", {
        target: snakeTarget(session),
        condition: args.condition,
        timeout_ms: timeout
      }, { timeoutMs: timeout + 500 });
    }

    if (name === "emacs_analyze") {
      const operation = requiredString(args, "operation");
      const requestedAdapter = typeof args.adapter === "string" ? args.adapter : null;
      const response = await client.request<Record<string, unknown>>("adapter.analyze", {
        target: snakeTarget(session),
        adapter: requestedAdapter,
        operation,
        params: args.params && typeof args.params === "object" ? args.params : {}
      });
      const dispatch = asRecordValue(response.analysis);
      const analysisResult = asRecordValue(dispatch.analysis ?? dispatch);
      return {
        analysis: {
          operation: typeof response.operation === "string" ? response.operation : operation,
          adapter: typeof dispatch.adapter === "string" ? dispatch.adapter : requestedAdapter,
          result: analysisResult,
          buffer_id: typeof response.buffer_id === "string" ? response.buffer_id : null,
          buffer_tick: typeof response.buffer_tick === "number" ? response.buffer_tick : null
        }
      };
    }

    if (name === "emacs_capture") {
      this.policy.assertCapture(session);
      const capabilities = await this.driver.initialize();
      if (!capabilities.connected) throw new OperatorError("E_NATIVE_DRIVER_UNAVAILABLE", "No native platform driver is connected.");
      if (!capabilities.screen_recording_granted) throw new OperatorError("E_SCREEN_CAPTURE_NOT_GRANTED", "Native window capture permission is not available to the connected Emacs Operator Host.");
      if (!capabilities.window_capture) throw new OperatorError("E_CAPTURE_FAILED", "The connected native host does not advertise window capture.");
      const record = this.bridges.findRecord(session.instanceId);
      const captured = await this.driver.captureEmacs(
        nativeTarget(session, record.pid, { window_title: args.window_title, window_identifier: args.window_identifier }),
        {
          max_width: typeof args.max_width === "number" ? Math.min(4096, Math.max(256, Math.floor(args.max_width))) : 2048,
          include_cursor: args.include_cursor === true
        }
      );
      const image = consumeCapturePNG(captured.path);
      return {
        width: captured.width,
        height: captured.height,
        bytes: image.bytes,
        mime_type: image.mime_type,
        image_data: image.data,
        transient_file_consumed: true
      };
    }

    if (name === "emacs_eval") {
      hooks.markMutation();
      this.policy.assertMutation(session);
      this.sessions.acquireMutation(session.sessionId);
      if (session.target.file) this.policy.assertFilePath(session, session.target.file);
      const language = requiredString(args, "language");
      if (language === "elisp") {
        this.policy.assertArbitraryElisp(session);
        throw new OperatorError("E_POLICY_DENIED", "Arbitrary Emacs Lisp source evaluation is disabled in this build.");
      }
      this.policy.assertStructuredEval(session);
      const operation = requiredString(args, "operation");
      const code = typeof args.code === "string" ? args.code : "";
      if (code.length > 0) {
        throw new OperatorError("E_POLICY_DENIED", "Source-string evaluation is disabled. Use a structured operation on code already present in the target buffer.");
      }
      validatePrecondition(args.precondition);
      const before = await this.observeCompact(client, session);
      hooks.setBefore(stateSummary(before));
      const result = await client.request<Record<string, unknown>>("adapter.eval", {
        target: snakeTarget(session),
        language,
        operation,
        adapter: args.adapter ?? null,
        timeout_ms: typeof args.timeout_ms === "number" ? Math.min(30000, Math.max(1, Math.floor(args.timeout_ms))) : null,
        code: "",
        precondition: args.precondition ?? null,
        policy: policyContext(session)
      });
      const afterObserved = await this.observeCompact(client, session);
      hooks.setAfter(stateSummary(afterObserved));
      return { execution: result, observed: afterObserved };
    }

    if (name === "emacs_workflow") {
      hooks.markMutation();
      this.policy.assertMutation(session);
      this.sessions.acquireMutation(session.sessionId);
      if (session.target.file) this.policy.assertFilePath(session, session.target.file);
      validatePrecondition(args.precondition);
      const before = await this.observeCompact(client, session);
      hooks.setBefore(stateSummary(before));
      const result = await this.executeSemanticWorkflow(session, args);
      const afterObserved = await this.observeCompact(client, this.sessions.get(session.sessionId));
      hooks.setAfter(stateSummary(afterObserved));
      return { workflow: result, observed: afterObserved };
    }

    if (name === "emacs_verification") {
      const action = requiredString(args, "action");
      if (!["start", "rerun", "status", "close"].includes(action)) {
        throw new OperatorError("E_INVALID_ARGUMENT", "Unsupported verification action.");
      }
      if (action === "status" || action === "close") {
        const ticketId = requiredString(args, "ticket_id");
        const ticket = this.verificationTickets.get(ticketId, session.sessionId);
        if (action === "close") {
          this.verificationTickets.close(ticketId, session.sessionId);
          return { verification: { status: "closed", ticket_id: ticketId } };
        }
        return { verification: { status: ticket.attempts.at(-1)?.completed === true ? "completed" : "open", ticket } };
      }

      hooks.markMutation();
      this.policy.assertMutation(session);
      this.policy.assertStructuredEval(session);
      this.sessions.acquireMutation(session.sessionId);
      if (session.target.file) this.policy.assertFilePath(session, session.target.file);

      const runEvaluation = async (operation: string, adapter: string | null, timeoutMs: number): Promise<VerificationAttempt> => {
        const response = await client.request<Record<string, unknown>>("adapter.eval", {
          target: snakeTarget(session),
          language: "buffer_language",
          operation,
          adapter,
          timeout_ms: timeoutMs,
          code: "",
          precondition: null,
          policy: policyContext(session)
        });
        return normalizeStructuredEvaluation(response);
      };

      const before = await this.observeCompact(client, session);
      hooks.setBefore(stateSummary(before));

      if (action === "start") {
        const operation = requiredString(args, "operation");
        if (!["eval_last_sexp", "eval_defun", "eval_region"].includes(operation)) {
          throw new OperatorError("E_INVALID_ARGUMENT", "Verification operation is not allowlisted.");
        }
        const timeoutMs = typeof args.timeout_ms === "number" ? Math.min(30000, Math.max(1, Math.floor(args.timeout_ms))) : 10000;
        const maxAttempts = typeof args.max_attempts === "number" ? Math.min(3, Math.max(1, Math.floor(args.max_attempts))) : 3;
        const sideEffectRisk = ["low", "high", "unknown"].includes(String(args.side_effect_risk)) ? String(args.side_effect_risk) as "low" | "high" | "unknown" : "unknown";
        const adapter = typeof args.adapter === "string" ? args.adapter : null;
        const attempt = await runEvaluation(operation, adapter, timeoutMs);
        const ticket = this.verificationTickets.create({
          sessionId: session.sessionId, adapter, operation, timeoutMs, maxAttempts, sideEffectRisk,
          allowRiskyRerun: args.allow_risky_rerun === true, attempts: [attempt]
        });
        const after = await this.observeCompact(client, session);
        hooks.setAfter(stateSummary(after));
        return { verification: { status: attempt.completed ? "completed" : "failed", ticket_id: ticket.ticketId, attempt_count: 1, attempt, rerun_requires_source_change: true, side_effect_risk: sideEffectRisk }, observed: after };
      }

      const ticketId = requiredString(args, "ticket_id");
      const ticket = this.verificationTickets.get(ticketId, session.sessionId);
      const last = ticket.attempts.at(-1)!;
      if (last.completed) return { verification: { status: "completed", reason: "already_completed", ticket_id: ticketId, attempts: ticket.attempts } };
      if (ticket.attempts.length >= ticket.maxAttempts) return { verification: { status: "stopped", reason: "max_attempts", ticket_id: ticketId, attempts: ticket.attempts } };
      if (["high", "unknown"].includes(ticket.sideEffectRisk) && !ticket.allowRiskyRerun) {
        return { verification: { status: "stopped", reason: "runtime_side_effect_risk", ticket_id: ticketId, attempts: ticket.attempts } };
      }
      const fingerprintResponse = await client.request<Record<string, unknown>>("adapter.analyze", {
        target: snakeTarget(session),
        adapter: "lisp",
        operation: "evaluation_source_fingerprint",
        params: { evaluation_operation: ticket.operation }
      });
      const currentFingerprint = analysisFingerprint(fingerprintResponse);
      const currentSha = currentFingerprint.sourceSha256;
      const previousSha = typeof last.metadata?.source_sha256 === "string" ? last.metadata.source_sha256 : null;
      const previousStart = sourceStartFromMetadata(asRecordValue(last.metadata));
      if (!currentSha || !previousSha) {
        return { verification: { status: "stopped", reason: "source_fingerprint_unavailable", ticket_id: ticketId, attempts: ticket.attempts } };
      }
      if (currentFingerprint.sourceStart === null || previousStart === null) {
        return { verification: { status: "stopped", reason: "source_locator_unavailable", ticket_id: ticketId, attempts: ticket.attempts } };
      }
      if (currentFingerprint.sourceStart !== previousStart) {
        return { verification: {
          status: "stopped", reason: "source_target_changed", ticket_id: ticketId, attempts: ticket.attempts,
          previous_source_start: previousStart, current_source_start: currentFingerprint.sourceStart,
          current_source_bounds: currentFingerprint.sourceBounds
        } };
      }
      if (currentSha === previousSha) {
        return { verification: { status: "stopped", reason: "source_unchanged", ticket_id: ticketId, attempts: ticket.attempts, source_sha256: currentSha, source_start: previousStart } };
      }
      const attempt = await runEvaluation(ticket.operation, ticket.adapter ?? null, ticket.timeoutMs);
      const updated = this.verificationTickets.append(ticketId, session.sessionId, attempt);
      const after = await this.observeCompact(client, session);
      hooks.setAfter(stateSummary(after));
      return { verification: { status: attempt.completed ? "completed" : "failed", ticket_id: ticketId, attempt_count: updated.attempts.length, attempt, attempts: updated.attempts }, observed: after };
    }

    if (name === "emacs_project_rename") {
      const action = requiredString(args, "action");
      if (!["plan", "preview", "apply", "status", "rollback", "commit"].includes(action)) {
        throw new OperatorError("E_INVALID_ARGUMENT", "Unsupported project rename action.");
      }
      const mutating = ["apply", "rollback", "commit"].includes(action);
      if (mutating) {
        hooks.markMutation();
        this.policy.assertMutation(session);
        this.sessions.acquireMutation(session.sessionId);
      }
      validatePrecondition(args.precondition);
      const before = await this.observeCompact(client, session);
      hooks.setBefore(stateSummary(before));
      const renameSemantics = action === "plan" ? prepareProjectRenameSymbols(args, before) : {};
      const result = await client.request<Record<string, unknown>>("refactor.project_rename", {
        target: snakeTarget(session),
        action,
        ...renameSemantics,
        include_definitions: args.include_definitions !== false,
        plan_id: typeof args.plan_id === "string" ? args.plan_id : null,
        journal_id: typeof args.journal_id === "string" ? args.journal_id : null,
        max_preview_edits: typeof args.max_preview_edits === "number" ? Math.min(200, Math.max(1, Math.floor(args.max_preview_edits))) : null,
        precondition: args.precondition ?? null,
        policy: policyContext(session)
      });
      const afterObserved = await this.observeCompact(client, session);
      hooks.setAfter(stateSummary(afterObserved));
      return { project_rename: result, observed: afterObserved };
    }

    if (name === "emacs_key_sequence") {
      hooks.markMutation();
      this.policy.assertMutation(session);
      this.sessions.acquireMutation(session.sessionId);
      if (session.target.file) this.policy.assertFilePath(session, session.target.file);
      const channel = (typeof args.channel === "string" ? args.channel : session.defaultChannel) as ExecutionChannel;
      if (channel !== "internal_keys" && channel !== "native_keys") throw new OperatorError("E_INVALID_ARGUMENT", "emacs_key_sequence requires internal_keys or native_keys channel.");
      this.policy.assertChannel(session, channel);
      validateInternalKeySteps(args.steps);
      validatePrecondition(args.precondition);
      const before = await this.observeCompact(client, session);
      hooks.setBefore(stateSummary(before));
      if (channel === "native_keys") {
        const record = this.bridges.findRecord(session.instanceId);
        const steps = args.steps as Array<Record<string, unknown>>;
        const events = steps.map((step) => {
          if (step.kind === "text") {
            return { kind: "text", text: String(step.value ?? "") };
          }
          if (step.kind !== "event" || !step.event || typeof step.event !== "object") {
            throw new OperatorError("E_INVALID_ARGUMENT", "native_keys accepts structured event or text steps. Use internal_keys for Emacs kbd notation and expect steps.");
          }
          const event = step.event as Record<string, unknown>;
          return {
            kind: String(event.kind ?? ""),
            ...(typeof event.key === "string" ? { key: event.key } : {}),
            ...(typeof event.code === "string" ? { code: event.code } : {}),
            ...(typeof event.text === "string" ? { text: event.text } : {}),
            ...(Array.isArray(event.modifiers) ? { modifiers: event.modifiers } : {}),
            ...(typeof event.repeat === "number" ? { repeat_count: event.repeat } : {}),
            ...(typeof event.delayAfterMs === "number" ? { delay_after_milliseconds: event.delayAfterMs } : {})
          };
        });
        const result = await this.driver.sendKeySequence(
          nativeTarget(session, record.pid),
          events,
          { raise_window: true, restore_frontmost: false, timeout_milliseconds: 1500 }
        );
        try {
          const afterObserved = await this.observeCompact(client, session);
          hooks.setAfter(stateSummary(afterObserved));
          const verification = this.verifyNativeExecution(afterObserved, args.verify);
          return { execution: result, verification, observed: afterObserved };
        } finally {
          if (args.restore_frontmost !== false && result.previous_frontmost) {
            await this.driver.restoreApplication(result.previous_frontmost);
          }
        }
      }
      const result = await client.request<Record<string, unknown>>("keys.execute", {
        target: snakeTarget(session),
        steps: args.steps,
        precondition: args.precondition ?? null,
        verify: args.verify ?? null,
        preserve_user_selection: true,
        policy: policyContext(session)
      });
      if (result.target && typeof result.target === "object") this.sessions.updateTarget(session.sessionId, result.target as unknown as ResolvedTarget);
      const updated = this.sessions.get(session.sessionId);
      const afterObserved = await this.observeCompact(client, updated);
      hooks.setAfter(stateSummary(afterObserved));
      return { execution: result, observed: afterObserved };
    }

    if (name === "emacs_command") {
      hooks.markMutation();
      this.policy.assertMutation(session);
      this.sessions.acquireMutation(session.sessionId);
      if (session.target.file) this.policy.assertFilePath(session, session.target.file);
      validatePrecondition(args.precondition);
      const before = await this.observeCompact(client, session);
      hooks.setBefore(stateSummary(before));
      const result = await client.request<Record<string, unknown>>("command.execute", {
        target: snakeTarget(session),
        command: requiredString(args, "command"),
        interactive: args.interactive !== false,
        prefix: args.prefix ?? null,
        arguments: Array.isArray(args.arguments) ? args.arguments : [],
        precondition: args.precondition ?? null,
        preserve_user_selection: true,
        policy: policyContext(session)
      });
      if (result.target && typeof result.target === "object") this.sessions.updateTarget(session.sessionId, result.target as unknown as ResolvedTarget);
      const afterObserved = await this.observeCompact(client, this.sessions.get(session.sessionId));
      hooks.setAfter(stateSummary(afterObserved));
      return { execution: result, observed: afterObserved };
    }

    if (name === "emacs_edit") {
      hooks.markMutation();
      this.policy.assertMutation(session);
      this.sessions.acquireMutation(session.sessionId);
      if (session.target.file) this.policy.assertFilePath(session, session.target.file);
      validatePrecondition(args.precondition);
      const before = await this.observeCompact(client, session);
      hooks.setBefore(stateSummary(before));
      const operation = requiredString(args, "operation");
      let request: Record<string, unknown>;
      if (operation === "apply_unified_diff") {
        const diff = requiredString(args, "diff");
        const resource = await client.request<Record<string, unknown>>("resource.read", { target: snakeTarget(session), range: "full" });
        if (typeof resource.text !== "string" || typeof resource.start !== "number" || typeof resource.end !== "number") {
          throw new OperatorError("E_INTERNAL", "Bridge returned an invalid full-buffer resource response.");
        }
        const nextText = applyUnifiedDiff(resource.text, diff);
        request = {
          target: snakeTarget(session),
          operation: "replace_range",
          start: resource.start,
          end: resource.end,
          text: nextText,
          precondition: args.precondition ?? { expected_buffer_tick: resource.buffer_tick ?? undefined },
          policy: policyContext(session)
        };
      } else {
        request = {
          target: snakeTarget(session),
          operation,
          position: args.position ?? null,
          start: args.start ?? null,
          end: args.end ?? null,
          text: args.text ?? "",
          precondition: args.precondition ?? null,
          policy: policyContext(session)
        };
      }
      const result = await client.request("edit.apply", request);
      const afterObserved = await this.observeCompact(client, session);
      hooks.setAfter(stateSummary(afterObserved));
      return { execution: result, observed: afterObserved };
    }

    if (name === "emacs_checkpoint") {
      hooks.markMutation();
      this.policy.assertMutation(session);
      this.sessions.acquireMutation(session.sessionId);
      const action = typeof args.action === "string" ? args.action : "create";
      const before = await this.observeCompact(client, session);
      hooks.setBefore(stateSummary(before));
      if (action === "commit") {
        const checkpointId = requiredString(args, "checkpoint_id");
        const result = await client.request("checkpoint.commit", { target: snakeTarget(session), checkpoint_id: checkpointId });
        hooks.setAfter(stateSummary(await this.observeCompact(client, session)));
        return result;
      }
      const result = await client.request("checkpoint.create", { target: snakeTarget(session), scope: args.scope ?? "buffer" });
      hooks.setAfter(stateSummary(before));
      return result;
    }

    if (name === "emacs_rollback") {
      hooks.markMutation();
      this.policy.assertMutation(session);
      this.sessions.acquireMutation(session.sessionId);
      const before = await this.observeCompact(client, session);
      hooks.setBefore(stateSummary(before));
      const result = await client.request("checkpoint.rollback", {
        target: snakeTarget(session),
        checkpoint_id: requiredString(args, "checkpoint_id")
      });
      hooks.setAfter(stateSummary(await this.observeCompact(client, session)));
      return result;
    }

    throw new OperatorError("E_INVALID_ARGUMENT", `Unknown tool: ${name}.`);
  }

  private async openSession(args: Record<string, unknown>, hooks: { setInstance(v: string): void }): Promise<unknown> {
    assertObject(args.selector, "selector");
    const selector = args.selector;
    const instanceId = typeof selector.instance_id === "string" ? selector.instance_id : undefined;
    const record = this.bridges.findRecord(instanceId);
    hooks.setInstance(record.instance_id);
    const permissionProfile = typeof args.permission_profile === "string" ? args.permission_profile : "workspace_edit";
    this.policy.profile(permissionProfile);
    const { client, initialization } = await this.bridges.connect(record);
    const target = await client.request<ResolvedTarget>("session.target.resolve", { selector });
    const init = initialization as Record<string, unknown>;
    const channels = init.channels && typeof init.channels === "object" ? init.channels as Record<string, unknown> : {};
    const features = init.features && typeof init.features === "object" ? init.features as Record<string, unknown> : {};
    const driverCapabilities = await this.driver.initialize();
    const capabilities: SessionCapabilities = {
      channels: {
        semantic: channels.semantic !== false,
        internal_keys: channels.internal_keys !== false,
        native_keys: driverCapabilities.connected && driverCapabilities.native_keyboard
      },
      features: {
        ...features,
        native_driver: driverCapabilities.connected,
        native_window_focus: driverCapabilities.window_focus,
        native_window_capture: driverCapabilities.window_capture,
        accessibility_trusted: driverCapabilities.accessibility_trusted,
        screen_recording_granted: driverCapabilities.screen_recording_granted
      }
    };
    const observed = await client.request<Record<string, unknown>>("state.observe", { target: {
      ...(target.frame_id ? { frame_id: target.frame_id } : {}),
      ...(target.window_id ? { window_id: target.window_id } : {}),
      buffer_id: target.buffer_id
    }, scope: ["compact"], around_chars: 256 });
    const defaultChannel = (typeof args.default_channel === "string" ? args.default_channel : "semantic") as ExecutionChannel;
    if (!capabilities.channels[defaultChannel]) throw new OperatorError("E_POLICY_DENIED", `Requested default channel ${defaultChannel} is unavailable.`);
    const state = stateSummary(observed);
    const session = this.sessions.open({
      instanceId: record.instance_id,
      defaultChannel,
      permissionProfile,
      target,
      capabilities,
      stateSeqAtOpen: state?.state_seq ?? 0
    });
    return { session, target, capabilities, state: observed };
  }

  private async workflowStep(sessionId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const envelope = await this.call(name, {
      ...args,
      session_id: sessionId,
      request_id: `wf_${crypto.randomUUID()}`
    });
    if (!envelope.ok) {
      throw new OperatorError(envelope.error.code, envelope.error.message, {
        ...(envelope.error.details ?? {}),
        workflow_step: name,
        workflow_audit_id: envelope.audit_id
      });
    }
    return envelope.result;
  }

  private workflowRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new OperatorError("E_INTERNAL", `${label} was not an object.`);
    }
    return value as Record<string, unknown>;
  }

  private workflowValidation(result: unknown, adapter: string): Record<string, unknown> {
    const top = this.workflowRecord(result, "workflow validation result");
    const bridge = this.workflowRecord(top.validation, "workflow validation bridge result");
    const validations = this.workflowRecord(bridge.validations, "workflow adapter validations");
    return this.workflowRecord(validations[adapter], `${adapter} validation`);
  }

  private workflowEvaluation(result: unknown): Record<string, unknown> {
    const top = this.workflowRecord(result, "workflow evaluation result");
    const execution = this.workflowRecord(top.execution, "workflow evaluation execution");
    const evaluation = this.workflowRecord(execution.evaluation, "workflow adapter evaluation");
    return this.workflowRecord(evaluation.result, "workflow adapter evaluation result");
  }

  private workflowAnalysis(result: unknown, adapter: string): Record<string, unknown> {
    const top = this.workflowRecord(result, "workflow analysis result");
    const analysis = this.workflowRecord(top.analysis, "workflow analysis payload");
    if (typeof analysis.adapter === "string" && analysis.adapter !== adapter) {
      throw new OperatorError("E_INTERNAL", `Expected ${adapter} analyzer but received ${analysis.adapter}.`);
    }
    if (analysis.result && typeof analysis.result === "object" && !Array.isArray(analysis.result)) {
      return this.workflowRecord(analysis.result, `${adapter} analysis result`);
    }
    // Compatibility with pre-alpha.10 nested Bridge-shaped analysis results.
    const dispatch = this.workflowRecord(analysis.analysis, "workflow adapter analysis dispatch");
    if (typeof dispatch.adapter === "string" && dispatch.adapter !== adapter) {
      throw new OperatorError("E_INTERNAL", `Expected ${adapter} analyzer but received ${dispatch.adapter}.`);
    }
    return this.workflowRecord(dispatch.analysis, `${adapter} analysis`);
  }

  private workflowCommandReturn(result: unknown): unknown {
    const top = this.workflowRecord(result, "workflow command result");
    const execution = this.workflowRecord(top.execution, "workflow command execution");
    return execution.return_value;
  }

  private workflowBounds(value: unknown, label: string): [number, number] {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number" || typeof value[1] !== "number") {
      throw new OperatorError("E_INTERNAL", `${label} did not contain numeric [start,end] bounds.`);
    }
    return [Math.floor(value[0]), Math.floor(value[1])];
  }

  private workflowLispObservation(result: unknown): Record<string, unknown> {
    const top = this.workflowRecord(result, "adapter observation");
    const adapters = this.workflowRecord(top.adapters, "adapter observation map");
    return this.workflowRecord(adapters.lisp, "Lisp adapter observation");
  }

  private workflowOrgObservation(result: unknown): Record<string, unknown> {
    const top = this.workflowRecord(result, "adapter observation");
    const adapters = this.workflowRecord(top.adapters, "adapter observation map");
    return this.workflowRecord(adapters.org, "Org adapter observation");
  }

  private async workflowRollback(sessionId: string, checkpointId: string): Promise<unknown> {
    try {
      return await this.workflowStep(sessionId, "emacs_rollback", { checkpoint_id: checkpointId });
    } catch (error) {
      const op = asOperatorError(error);
      throw new OperatorError("E_ROLLBACK_FAILED", "Semantic workflow failed and its automatic rollback also failed.", {
        checkpoint_id: checkpointId,
        rollback_error: op.toJSON()
      });
    }
  }

  private workflowTransactionScope(runtimeTouched: boolean): Record<string, unknown> {
    return {
      buffer: "checkpoint_managed",
      runtime: runtimeTouched ? "not_transactional" : "not_touched_by_workflow_evaluation",
      ...(runtimeTouched ? {
        warning: "Buffer rollback does not guarantee reversal of Lisp REPL, Babel, filesystem, process, network, or other runtime side effects already produced by evaluation."
      } : {})
    };
  }

  private async workflowProposalFailure(
    sessionId: string,
    checkpointId: string,
    operation: string,
    reason: string,
    details: Record<string, unknown>,
    runtimeTouched = false
  ): Promise<Record<string, unknown>> {
    const rollback = await this.workflowRollback(sessionId, checkpointId);
    return {
      operation,
      status: "rolled_back",
      reason,
      checkpoint_id: checkpointId,
      transaction_scope: this.workflowTransactionScope(runtimeTouched),
      rollback,
      ...details
    };
  }

  private workflowEvaluationRequest(value: unknown, label = "evaluation"): Record<string, unknown> {
    assertObject(value, label);
    const operation = requiredString(value, "operation");
    if (!["eval_last_sexp", "eval_defun", "eval_region"].includes(operation)) {
      throw new OperatorError("E_INVALID_ARGUMENT", `${label}.operation must be eval_last_sexp, eval_defun, or eval_region.`);
    }
    const timeout = typeof value.timeout_ms === "number" ? Math.min(30_000, Math.max(1, Math.floor(value.timeout_ms))) : 5_000;
    const request: Record<string, unknown> = {
      language: "buffer_language",
      operation,
      adapter: typeof value.adapter === "string" && value.adapter.length > 0 ? value.adapter : "lisp",
      timeout_ms: timeout
    };
    if (value.expected_value !== undefined) request.expected_value = String(value.expected_value);
    if (value.navigation !== undefined) {
      assertObject(value.navigation, `${label}.navigation`);
      request.navigation = { ...value.navigation };
    }
    return request;
  }

  private workflowEvaluationRequests(value: unknown): Record<string, unknown>[] {
    if (value === undefined || value === null) return [];
    assertObject(value, "evaluation");
    if (Array.isArray(value.steps)) {
      if (value.steps.length === 0 || value.steps.length > 8) {
        throw new OperatorError("E_INVALID_ARGUMENT", "evaluation.steps must contain 1 to 8 structured evaluation steps.");
      }
      return value.steps.map((step, index) => this.workflowEvaluationRequest(step, `evaluation.steps[${index}]`));
    }
    return [this.workflowEvaluationRequest(value)];
  }

  private async workflowRunEvaluations(sessionId: string, requests: Record<string, unknown>[]): Promise<{
    results: Record<string, unknown>[];
    failure?: { reason: "runtime_condition" | "unexpected_value"; result: Record<string, unknown>; expected_value?: string };
  }> {
    const results: Record<string, unknown>[] = [];
    for (const request of requests) {
      const navigation = request.navigation;
      if (navigation !== undefined) {
        assertObject(navigation, "evaluation navigation");
        await this.workflowStep(sessionId, "emacs_navigate", { ...navigation });
      }
      const expectedValue = request.expected_value;
      const evalArgs = { ...request };
      delete evalArgs.expected_value;
      delete evalArgs.navigation;
      const evaluated = await this.workflowStep(sessionId, "emacs_eval", evalArgs);
      const result = this.workflowEvaluation(evaluated);
      results.push(result);
      if (result.completed !== true) {
        return { results, failure: { reason: "runtime_condition", result } };
      }
      if (expectedValue !== undefined && String(result.value) !== String(expectedValue)) {
        return { results, failure: { reason: "unexpected_value", result, expected_value: String(expectedValue) } };
      }
    }
    return { results };
  }

  private async executeSemanticWorkflow(session: EmacsSession, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const operation = requiredString(args, "operation");
    const supported = [
      "repair_lisp", "refactor_defun", "rename_symbol", "extract_function",
      "move_form", "transform_sexp", "org_build_section", "org_rewrite_subtree"
    ];
    if (!supported.includes(operation)) {
      throw new OperatorError("E_INVALID_ARGUMENT", `Unknown semantic workflow operation: ${operation}.`);
    }
    if (operation === "repair_lisp") return this.workflowRepairLisp(session, args);
    if (operation === "refactor_defun") return this.workflowRefactorDefun(session, args);
    if (operation === "rename_symbol") return this.workflowRenameSymbol(session, args);
    if (operation === "extract_function") return this.workflowExtractFunction(session, args);
    if (operation === "move_form") return this.workflowMoveForm(session, args);
    if (operation === "transform_sexp") return this.workflowTransformSexp(session, args);
    if (operation === "org_rewrite_subtree") return this.workflowOrgRewriteSubtree(session, args);
    return this.workflowOrgBuildSection(session, args);
  }

  private async workflowRepairLisp(session: EmacsSession, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertObject(args.edit, "edit");
    const edit = args.edit;
    const editOperation = requiredString(edit, "operation");
    if (!["insert", "replace_range", "delete_range", "apply_unified_diff"].includes(editOperation)) {
      throw new OperatorError("E_INVALID_ARGUMENT", "repair_lisp edit operation must be insert, replace_range, delete_range, or apply_unified_diff.");
    }
    const evaluations = this.workflowEvaluationRequests(args.evaluation);
    if (evaluations.length > 0) this.policy.assertStructuredEval(session);
    const checkpoint = this.workflowRecord(await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "create" }), "repair checkpoint");
    const checkpointId = requiredString(checkpoint, "checkpoint_id");
    try {
      const editArgs: Record<string, unknown> = { ...edit, operation: editOperation };
      if (args.precondition !== undefined) editArgs.precondition = args.precondition;
      const edited = await this.workflowStep(session.sessionId, "emacs_edit", editArgs);
      const validated = await this.workflowStep(session.sessionId, "emacs_validate", {
        adapter: "lisp",
        options: args.validate_options && typeof args.validate_options === "object" ? args.validate_options : {}
      });
      const lispValidation = this.workflowValidation(validated, "lisp");
      if (lispValidation.valid !== true) {
        return this.workflowProposalFailure(session.sessionId, checkpointId, "repair_lisp", "validation_failed", {
          edit: edited,
          validation: lispValidation
        });
      }
      let evaluationResults: Record<string, unknown>[] = [];
      if (evaluations.length > 0) {
        const run = await this.workflowRunEvaluations(session.sessionId, evaluations);
        evaluationResults = run.results;
        if (run.failure) {
          return this.workflowProposalFailure(session.sessionId, checkpointId, "repair_lisp", run.failure.reason, {
            edit: edited,
            validation: lispValidation,
            evaluations: evaluationResults,
            ...(run.failure.expected_value !== undefined ? { expected_value: run.failure.expected_value } : {})
          }, true);
        }
      }
      const commit = await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "commit", checkpoint_id: checkpointId });
      return {
        operation: "repair_lisp",
        status: "committed",
        checkpoint_id: checkpointId,
        transaction_scope: this.workflowTransactionScope(evaluationResults.length > 0),
        edit: edited,
        validation: lispValidation,
        ...(evaluationResults.length === 1 ? { evaluation: evaluationResults[0] } : {}),
        ...(evaluationResults.length > 1 ? { evaluations: evaluationResults } : {}),
        commit
      };
    } catch (error) {
      try { await this.workflowRollback(session.sessionId, checkpointId); } catch (rollbackError) { throw rollbackError; }
      throw error;
    }
  }

  private async workflowRefactorDefun(session: EmacsSession, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const replacement = requiredString(args, "replacement");
    if (Buffer.byteLength(replacement, "utf8") > 262_144) {
      throw new OperatorError("E_INVALID_ARGUMENT", "refactor_defun replacement exceeds the 256 KiB safety bound.");
    }
    const observedAdapters = await this.workflowStep(session.sessionId, "emacs_capabilities", { operation: "adapter_observe" });
    const lispBefore = this.workflowLispObservation(observedAdapters);
    const [start, end] = this.workflowBounds(lispBefore.defun_bounds, "Lisp defun observation");
    const expectedName = typeof args.expected_name === "string" && args.expected_name.length > 0 ? args.expected_name : undefined;
    if (expectedName && lispBefore.defun_name !== expectedName) {
      throw new OperatorError("E_STATE_CONFLICT", "The current Lisp defun does not match expected_name.", {
        expected_name: expectedName,
        actual_name: lispBefore.defun_name ?? null
      });
    }
    const evaluations = this.workflowEvaluationRequests(args.evaluation);
    if (evaluations.length > 0) this.policy.assertStructuredEval(session);
    const checkpoint = this.workflowRecord(await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "create" }), "refactor checkpoint");
    const checkpointId = requiredString(checkpoint, "checkpoint_id");
    try {
      const editArgs: Record<string, unknown> = { operation: "replace_range", start, end, text: replacement };
      if (args.precondition !== undefined) editArgs.precondition = args.precondition;
      const edited = await this.workflowStep(session.sessionId, "emacs_edit", editArgs);
      const validated = await this.workflowStep(session.sessionId, "emacs_validate", {
        adapter: "lisp",
        options: args.validate_options && typeof args.validate_options === "object" ? args.validate_options : {}
      });
      const lispValidation = this.workflowValidation(validated, "lisp");
      if (lispValidation.valid !== true) {
        return this.workflowProposalFailure(session.sessionId, checkpointId, "refactor_defun", "validation_failed", {
          defun_bounds_before: [start, end], edit: edited, validation: lispValidation
        });
      }
      await this.workflowStep(session.sessionId, "emacs_navigate", { operation: "goto_position", position: start });
      const adaptersAfter = await this.workflowStep(session.sessionId, "emacs_capabilities", { operation: "adapter_observe" });
      const lispAfter = this.workflowLispObservation(adaptersAfter);
      if (expectedName && lispAfter.defun_name !== expectedName) {
        return this.workflowProposalFailure(session.sessionId, checkpointId, "refactor_defun", "defun_identity_changed", {
          expected_name: expectedName,
          actual_name: lispAfter.defun_name ?? null,
          validation: lispValidation
        });
      }
      let evaluationResults: Record<string, unknown>[] = [];
      if (evaluations.length > 0) {
        const run = await this.workflowRunEvaluations(session.sessionId, evaluations);
        evaluationResults = run.results;
        if (run.failure) {
          return this.workflowProposalFailure(session.sessionId, checkpointId, "refactor_defun", run.failure.reason, {
            validation: lispValidation,
            evaluations: evaluationResults,
            ...(run.failure.expected_value !== undefined ? { expected_value: run.failure.expected_value } : {})
          }, true);
        }
      }
      const commit = await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "commit", checkpoint_id: checkpointId });
      return {
        operation: "refactor_defun",
        status: "committed",
        checkpoint_id: checkpointId,
        transaction_scope: this.workflowTransactionScope(evaluationResults.length > 0),
        defun_bounds_before: [start, end],
        defun_name: lispAfter.defun_name ?? null,
        validation: lispValidation,
        ...(evaluationResults.length === 1 ? { evaluation: evaluationResults[0] } : {}),
        ...(evaluationResults.length > 1 ? { evaluations: evaluationResults } : {}),
        commit
      };
    } catch (error) {
      try { await this.workflowRollback(session.sessionId, checkpointId); } catch (rollbackError) { throw rollbackError; }
      throw error;
    }
  }

  private async workflowRenameSymbol(session: EmacsSession, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const oldSymbol = requiredString(args, "old_symbol");
    const newSymbol = requiredString(args, "new_symbol");
    if (Buffer.byteLength(oldSymbol, "utf8") > 512 || Buffer.byteLength(newSymbol, "utf8") > 512) {
      throw new OperatorError("E_INVALID_ARGUMENT", "Lisp symbol tokens are limited to 512 bytes.");
    }
    const scope = typeof args.scope === "string" ? args.scope : "current_defun";
    if (!['current_defun', 'buffer'].includes(scope)) {
      throw new OperatorError("E_INVALID_ARGUMENT", "rename_symbol scope must be current_defun or buffer.");
    }
    const maxReplacements = typeof args.max_replacements === "number" ? Math.floor(args.max_replacements) : 10_000;
    if (maxReplacements < 1 || maxReplacements > 10_000) {
      throw new OperatorError("E_INVALID_ARGUMENT", "max_replacements must be from 1 to 10000.");
    }
    const expectedName = typeof args.expected_name === "string" && args.expected_name.length > 0 ? args.expected_name : undefined;
    if (expectedName && scope !== "current_defun") {
      throw new OperatorError("E_INVALID_ARGUMENT", "rename_symbol expected_name is only valid with scope=current_defun.");
    }
    if (expectedName) {
      const observedAdapters = await this.workflowStep(session.sessionId, "emacs_capabilities", { operation: "adapter_observe" });
      const lispBefore = this.workflowLispObservation(observedAdapters);
      if (lispBefore.defun_name !== expectedName) {
        throw new OperatorError("E_STATE_CONFLICT", "The current Lisp defun does not match expected_name for rename_symbol.", {
          expected_name: expectedName, actual_name: lispBefore.defun_name ?? null
        });
      }
    }
    const evaluations = this.workflowEvaluationRequests(args.evaluation);
    if (evaluations.length > 0) this.policy.assertStructuredEval(session);
    const checkpoint = this.workflowRecord(await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "create" }), "rename checkpoint");
    const checkpointId = requiredString(checkpoint, "checkpoint_id");
    try {
      const commandArgs: Record<string, unknown> = {
        command: "emacs-operator-lisp-rename-symbol",
        interactive: false,
        arguments: [oldSymbol, newSymbol, scope, maxReplacements]
      };
      if (args.precondition !== undefined) commandArgs.precondition = args.precondition;
      const mutated = await this.workflowStep(session.sessionId, "emacs_command", commandArgs);
      const mutation = this.workflowRecord(this.workflowCommandReturn(mutated), "rename_symbol return value");
      const replacements = typeof mutation.replacements === "number" ? Math.floor(mutation.replacements) : 0;
      if (replacements < 1) {
        return this.workflowProposalFailure(session.sessionId, checkpointId, "rename_symbol", "symbol_not_found", { mutation });
      }
      const validated = await this.workflowStep(session.sessionId, "emacs_validate", {
        adapter: "lisp",
        options: args.validate_options && typeof args.validate_options === "object" ? args.validate_options : {}
      });
      const validation = this.workflowValidation(validated, "lisp");
      if (validation.valid !== true) {
        return this.workflowProposalFailure(session.sessionId, checkpointId, "rename_symbol", "validation_failed", { mutation, validation });
      }
      let evaluationResults: Record<string, unknown>[] = [];
      if (evaluations.length > 0) {
        const run = await this.workflowRunEvaluations(session.sessionId, evaluations);
        evaluationResults = run.results;
        if (run.failure) {
          return this.workflowProposalFailure(session.sessionId, checkpointId, "rename_symbol", run.failure.reason, {
            mutation, validation, evaluations: evaluationResults,
            ...(run.failure.expected_value !== undefined ? { expected_value: run.failure.expected_value } : {})
          }, true);
        }
      }
      const commit = await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "commit", checkpoint_id: checkpointId });
      return {
        operation: "rename_symbol", status: "committed", checkpoint_id: checkpointId,
        transaction_scope: this.workflowTransactionScope(evaluationResults.length > 0),
        mutation, validation,
        ...(evaluationResults.length === 1 ? { evaluation: evaluationResults[0] } : {}),
        ...(evaluationResults.length > 1 ? { evaluations: evaluationResults } : {}),
        commit
      };
    } catch (error) {
      try { await this.workflowRollback(session.sessionId, checkpointId); } catch (rollbackError) { throw rollbackError; }
      throw error;
    }
  }

  private async workflowExtractFunction(session: EmacsSession, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertObject(args.range, "range");
    const start = typeof args.range.start === "number" ? Math.floor(args.range.start) : NaN;
    const end = typeof args.range.end === "number" ? Math.floor(args.range.end) : NaN;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end <= start) {
      throw new OperatorError("E_INVALID_ARGUMENT", "extract_function requires range.start < range.end with positive integer positions.");
    }
    const name = requiredString(args, "name");
    if (Buffer.byteLength(name, "utf8") > 512) throw new OperatorError("E_INVALID_ARGUMENT", "Extracted function name exceeds 512 bytes.");
    let analysis: Record<string, unknown> | undefined;
    let parameters: unknown = args.parameters;
    if (parameters === undefined) {
      const analyzed = await this.workflowStep(session.sessionId, "emacs_analyze", {
        adapter: "lisp",
        operation: "infer_extract_parameters",
        params: { bounds: [start, end] }
      });
      analysis = this.workflowAnalysis(analyzed, "lisp");
      const unresolved = Array.isArray(analysis.unresolved) ? analysis.unresolved.filter((item) => typeof item === "string") : [];
      if (unresolved.length > 0) {
        throw new OperatorError("E_ANALYSIS_UNRESOLVED", "extract_function parameter inference is unresolved; provide explicit parameters or narrow the selected forms.", {
          unresolved,
          analysis
        });
      }
      parameters = Array.isArray(analysis.parameters) ? analysis.parameters : [];
    }
    if (!Array.isArray(parameters) || parameters.length > 128 || parameters.some((item) => typeof item !== "string" || item.length === 0 || Buffer.byteLength(item, "utf8") > 512)) {
      throw new OperatorError("E_INVALID_ARGUMENT", "extract_function parameters must contain at most 128 non-empty symbol strings of at most 512 bytes.");
    }
    const expectedName = typeof args.expected_name === "string" && args.expected_name.length > 0 ? args.expected_name : undefined;
    if (expectedName) {
      const observedAdapters = await this.workflowStep(session.sessionId, "emacs_capabilities", { operation: "adapter_observe" });
      const lispBefore = this.workflowLispObservation(observedAdapters);
      if (lispBefore.defun_name !== expectedName) {
        throw new OperatorError("E_STATE_CONFLICT", "The current Lisp defun does not match expected_name for extract_function.", {
          expected_name: expectedName, actual_name: lispBefore.defun_name ?? null
        });
      }
    }
    const evaluations = this.workflowEvaluationRequests(args.evaluation);
    const evaluateDefinition = args.evaluate_definition === true;
    const evaluateEnclosingDefinition = args.evaluate_enclosing_definition === true;
    if (evaluateEnclosingDefinition && !evaluateDefinition) {
      throw new OperatorError("E_INVALID_ARGUMENT", "evaluate_enclosing_definition requires evaluate_definition=true so the extracted helper is loaded first.");
    }
    if (evaluateDefinition || evaluateEnclosingDefinition || evaluations.length > 0) this.policy.assertStructuredEval(session);
    const checkpoint = this.workflowRecord(await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "create" }), "extract checkpoint");
    const checkpointId = requiredString(checkpoint, "checkpoint_id");
    try {
      const commandArgs: Record<string, unknown> = {
        command: "emacs-operator-lisp-extract-function",
        interactive: false,
        arguments: [start, end, name, parameters]
      };
      if (args.precondition !== undefined) commandArgs.precondition = args.precondition;
      const mutated = await this.workflowStep(session.sessionId, "emacs_command", commandArgs);
      const mutation = this.workflowRecord(this.workflowCommandReturn(mutated), "extract_function return value");
      const validated = await this.workflowStep(session.sessionId, "emacs_validate", {
        adapter: "lisp",
        options: args.validate_options && typeof args.validate_options === "object" ? args.validate_options : {}
      });
      const validation = this.workflowValidation(validated, "lisp");
      if (validation.valid !== true) {
        return this.workflowProposalFailure(session.sessionId, checkpointId, "extract_function", "validation_failed", { mutation, validation });
      }
      const allEvaluations: Record<string, unknown>[] = [];
      if (evaluateDefinition) {
        const [definitionStart] = this.workflowBounds(mutation.new_definition_bounds, "extracted definition bounds");
        await this.workflowStep(session.sessionId, "emacs_navigate", { operation: "goto_position", position: definitionStart });
        const evaluated = await this.workflowStep(session.sessionId, "emacs_eval", {
          language: "buffer_language", operation: "eval_defun", adapter: "lisp", timeout_ms: 5_000
        });
        const definitionResult = this.workflowEvaluation(evaluated);
        allEvaluations.push(definitionResult);
        if (definitionResult.completed !== true) {
          return this.workflowProposalFailure(session.sessionId, checkpointId, "extract_function", "runtime_condition", {
            mutation, validation, evaluations: allEvaluations
          }, true);
        }
      }
      if (evaluateEnclosingDefinition) {
        // Navigate to the generated call, which is guaranteed to remain inside
        // the refactored enclosing definition. Its reported beginning can sit on
        // inter-definition whitespace, where `beginning-of-defun` may select the
        // newly inserted helper instead.
        this.workflowBounds(mutation.enclosing_definition_bounds, "enclosing definition bounds");
        const [callStart] = this.workflowBounds(mutation.call_bounds, "extracted call bounds");
        await this.workflowStep(session.sessionId, "emacs_navigate", { operation: "goto_position", position: callStart });
        const evaluated = await this.workflowStep(session.sessionId, "emacs_eval", {
          language: "buffer_language", operation: "eval_defun", adapter: "lisp", timeout_ms: 5_000
        });
        const enclosingResult = this.workflowEvaluation(evaluated);
        allEvaluations.push(enclosingResult);
        if (enclosingResult.completed !== true) {
          return this.workflowProposalFailure(session.sessionId, checkpointId, "extract_function", "runtime_condition", {
            mutation, validation, evaluations: allEvaluations
          }, true);
        }
      }
      if (evaluations.length > 0) {
        const run = await this.workflowRunEvaluations(session.sessionId, evaluations);
        allEvaluations.push(...run.results);
        if (run.failure) {
          return this.workflowProposalFailure(session.sessionId, checkpointId, "extract_function", run.failure.reason, {
            mutation, validation, evaluations: allEvaluations,
            ...(run.failure.expected_value !== undefined ? { expected_value: run.failure.expected_value } : {})
          }, true);
        }
      }
      const commit = await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "commit", checkpoint_id: checkpointId });
      return {
        operation: "extract_function", status: "committed", checkpoint_id: checkpointId,
        transaction_scope: this.workflowTransactionScope(allEvaluations.length > 0),
        mutation, validation,
        ...(analysis ? { analysis } : {}),
        ...(allEvaluations.length === 1 ? { evaluation: allEvaluations[0] } : {}),
        ...(allEvaluations.length > 1 ? { evaluations: allEvaluations } : {}),
        commit
      };
    } catch (error) {
      try { await this.workflowRollback(session.sessionId, checkpointId); } catch (rollbackError) { throw rollbackError; }
      throw error;
    }
  }

  private async workflowMoveForm(session: EmacsSession, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const direction = typeof args.direction === "string" ? args.direction : "down";
    if (!['up', 'down', 'backward', 'forward'].includes(direction)) {
      throw new OperatorError("E_INVALID_ARGUMENT", "move_form direction must be up, down, backward, or forward.");
    }
    const count = typeof args.count === "number" ? Math.floor(args.count) : 1;
    if (count < 1 || count > 100) throw new OperatorError("E_INVALID_ARGUMENT", "move_form count must be from 1 to 100.");
    return this.workflowValidatedLispCommand(session, "move_form", "emacs-operator-lisp-move-top-level-form", [direction, count], args);
  }

  private async workflowTransformSexp(session: EmacsSession, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const transform = requiredString(args, "transform");
    const allowed = ["slurp_forward", "barf_forward", "splice", "wrap_round", "raise", "split", "join", "indent_defun"];
    if (!allowed.includes(transform)) {
      throw new OperatorError("E_INVALID_ARGUMENT", `Unsupported structural transform: ${transform}.`);
    }
    const count = typeof args.count === "number" ? Math.floor(args.count) : 1;
    if (count < 1 || count > 100) throw new OperatorError("E_INVALID_ARGUMENT", "transform_sexp count must be from 1 to 100.");
    return this.workflowValidatedLispCommand(session, "transform_sexp", "emacs-operator-lisp-structural-edit", [transform, count], args);
  }

  private async workflowValidatedLispCommand(
    session: EmacsSession,
    operation: string,
    command: string,
    commandArguments: unknown[],
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const evaluations = this.workflowEvaluationRequests(args.evaluation);
    if (evaluations.length > 0) this.policy.assertStructuredEval(session);
    const checkpoint = this.workflowRecord(await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "create" }), `${operation} checkpoint`);
    const checkpointId = requiredString(checkpoint, "checkpoint_id");
    try {
      const commandArgs: Record<string, unknown> = { command, interactive: false, arguments: commandArguments };
      if (args.precondition !== undefined) commandArgs.precondition = args.precondition;
      const mutated = await this.workflowStep(session.sessionId, "emacs_command", commandArgs);
      const mutation = this.workflowCommandReturn(mutated);
      const validated = await this.workflowStep(session.sessionId, "emacs_validate", {
        adapter: "lisp",
        options: args.validate_options && typeof args.validate_options === "object" ? args.validate_options : {}
      });
      const validation = this.workflowValidation(validated, "lisp");
      if (validation.valid !== true) {
        return this.workflowProposalFailure(session.sessionId, checkpointId, operation, "validation_failed", { mutation, validation });
      }
      let evaluationResults: Record<string, unknown>[] = [];
      if (evaluations.length > 0) {
        const run = await this.workflowRunEvaluations(session.sessionId, evaluations);
        evaluationResults = run.results;
        if (run.failure) {
          return this.workflowProposalFailure(session.sessionId, checkpointId, operation, run.failure.reason, {
            mutation, validation, evaluations: evaluationResults,
            ...(run.failure.expected_value !== undefined ? { expected_value: run.failure.expected_value } : {})
          }, true);
        }
      }
      const commit = await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "commit", checkpoint_id: checkpointId });
      return {
        operation, status: "committed", checkpoint_id: checkpointId,
        transaction_scope: this.workflowTransactionScope(evaluationResults.length > 0),
        mutation, validation,
        ...(evaluationResults.length === 1 ? { evaluation: evaluationResults[0] } : {}),
        ...(evaluationResults.length > 1 ? { evaluations: evaluationResults } : {}),
        commit
      };
    } catch (error) {
      try { await this.workflowRollback(session.sessionId, checkpointId); } catch (rollbackError) { throw rollbackError; }
      throw error;
    }
  }

  private async workflowOrgRewriteSubtree(session: EmacsSession, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertObject(args.rewrite, "rewrite");
    const rewrite = args.rewrite;
    const mutableKeys = ["title", "todo", "tags", "properties", "body", "move"];
    if (!mutableKeys.some((key) => Object.prototype.hasOwnProperty.call(rewrite, key))) {
      throw new OperatorError("E_INVALID_ARGUMENT", "org_rewrite_subtree requires at least one mutation field.");
    }
    if (typeof rewrite.body === "string" && Buffer.byteLength(rewrite.body, "utf8") > 262_144) {
      throw new OperatorError("E_INVALID_ARGUMENT", "Org rewrite body exceeds the 256 KiB safety bound.");
    }
    const observedAdapters = await this.workflowStep(session.sessionId, "emacs_capabilities", { operation: "adapter_observe" });
    const orgBefore = this.workflowOrgObservation(observedAdapters);
    const headingBefore = orgBefore.heading && typeof orgBefore.heading === "object" ? orgBefore.heading as Record<string, unknown> : undefined;
    const expectedTitle = typeof rewrite.expected_title === "string" && rewrite.expected_title.length > 0 ? rewrite.expected_title : undefined;
    if (expectedTitle && headingBefore?.title !== expectedTitle) {
      throw new OperatorError("E_STATE_CONFLICT", "The current Org subtree does not match expected_title.", {
        expected_title: expectedTitle, actual_title: headingBefore?.title ?? null
      });
    }
    if (rewrite.properties !== undefined) assertObject(rewrite.properties, "rewrite.properties");
    if (rewrite.move !== undefined) assertObject(rewrite.move, "rewrite.move");
    const checkpoint = this.workflowRecord(await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "create" }), "Org rewrite checkpoint");
    const checkpointId = requiredString(checkpoint, "checkpoint_id");
    const mutations: unknown[] = [];
    try {
      let first = true;
      const runCommand = async (command: string, commandArguments: unknown[]) => {
        const commandArgs: Record<string, unknown> = { command, interactive: false, arguments: commandArguments };
        if (first && args.precondition !== undefined) commandArgs.precondition = args.precondition;
        first = false;
        const result = await this.workflowStep(session.sessionId, "emacs_command", commandArgs);
        mutations.push(this.workflowCommandReturn(result));
      };
      if (typeof rewrite.title === "string") await runCommand("emacs-operator-org-set-title", [rewrite.title]);
      if (Object.prototype.hasOwnProperty.call(rewrite, "todo")) {
        if (rewrite.todo !== null && typeof rewrite.todo !== "string") throw new OperatorError("E_SCHEMA_VALIDATION", "rewrite.todo must be a string or null.");
        await runCommand("emacs-operator-org-set-todo", [rewrite.todo ?? null]);
      }
      if (rewrite.tags !== undefined) {
        if (!Array.isArray(rewrite.tags)) throw new OperatorError("E_SCHEMA_VALIDATION", "rewrite.tags must be an array.");
        await runCommand("emacs-operator-org-set-tags", [rewrite.tags]);
      }
      if (rewrite.properties !== undefined) {
        for (const [property, value] of Object.entries(rewrite.properties)) {
          if (typeof value !== "string") throw new OperatorError("E_SCHEMA_VALIDATION", `Org property ${property} must be a string.`);
          await runCommand("emacs-operator-org-set-property", [property, value]);
        }
      }
      if (typeof rewrite.body === "string") await runCommand("emacs-operator-org-rewrite-section-body", [rewrite.body]);
      if (rewrite.move !== undefined) {
        const direction = requiredString(rewrite.move, "direction");
        if (!['up', 'down'].includes(direction)) throw new OperatorError("E_INVALID_ARGUMENT", "Org subtree move direction must be up or down.");
        const count = typeof rewrite.move.count === "number" ? Math.floor(rewrite.move.count) : 1;
        if (count < 1 || count > 100) throw new OperatorError("E_INVALID_ARGUMENT", "Org subtree move count must be from 1 to 100.");
        await runCommand(direction === "up" ? "emacs-operator-org-move-subtree-up" : "emacs-operator-org-move-subtree-down", [count]);
      }
      const validated = await this.workflowStep(session.sessionId, "emacs_validate", {
        adapter: "org",
        options: args.validate_options && typeof args.validate_options === "object" ? args.validate_options : {}
      });
      const validation = this.workflowValidation(validated, "org");
      if (validation.valid !== true) {
        return this.workflowProposalFailure(session.sessionId, checkpointId, "org_rewrite_subtree", "validation_failed", { mutations, validation });
      }
      const commit = await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "commit", checkpoint_id: checkpointId });
      return {
        operation: "org_rewrite_subtree", status: "committed", checkpoint_id: checkpointId,
        transaction_scope: this.workflowTransactionScope(false), mutations, validation, commit
      };
    } catch (error) {
      try { await this.workflowRollback(session.sessionId, checkpointId); } catch (rollbackError) { throw rollbackError; }
      throw error;
    }
  }

  private async workflowOrgBuildSection(session: EmacsSession, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertObject(args.section, "section");
    const section = args.section;
    const title = requiredString(section, "title");
    const level = typeof section.level === "number" ? Math.floor(section.level) : 1;
    if (level < 1 || level > 50) throw new OperatorError("E_INVALID_ARGUMENT", "Org section level must be from 1 to 50.");
    const placement = typeof section.placement === "string" ? section.placement : "buffer_end";
    if (placement !== "buffer_end" && placement !== "at_point") {
      throw new OperatorError("E_INVALID_ARGUMENT", "Org section placement must be buffer_end or at_point.");
    }
    const body = typeof section.body === "string" ? section.body : undefined;
    if (body !== undefined && Buffer.byteLength(body, "utf8") > 262_144) {
      throw new OperatorError("E_INVALID_ARGUMENT", "Org section body exceeds the 256 KiB safety bound.");
    }
    const source = section.source_block;
    if (source !== undefined) assertObject(source, "section.source_block");
    const executeBabel = !!(source && source.execute === true);
    if (executeBabel) this.policy.assertStructuredEval(session);
    const checkpoint = this.workflowRecord(await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "create" }), "Org workflow checkpoint");
    const checkpointId = requiredString(checkpoint, "checkpoint_id");
    try {
      if (placement === "buffer_end") {
        await this.workflowStep(session.sessionId, "emacs_navigate", { operation: "buffer_end" });
      }
      const createArgs: Record<string, unknown> = {
        command: "emacs-operator-org-create-heading",
        interactive: false,
        arguments: [title, level, section.todo ?? null, Array.isArray(section.tags) ? section.tags : null]
      };
      if (args.precondition !== undefined) createArgs.precondition = args.precondition;
      const headingCommand = await this.workflowStep(session.sessionId, "emacs_command", createArgs);
      const headingReturn = this.workflowRecord(this.workflowCommandReturn(headingCommand), "Org create heading return value");
      const headingStart = typeof headingReturn.start === "number" ? Math.floor(headingReturn.start) : undefined;

      if (section.properties !== undefined) {
        assertObject(section.properties, "section.properties");
        for (const [property, value] of Object.entries(section.properties)) {
          if (typeof value !== "string") throw new OperatorError("E_SCHEMA_VALIDATION", `Org property ${property} must be a string.`);
          await this.workflowStep(session.sessionId, "emacs_command", {
            command: "emacs-operator-org-set-property", interactive: false, arguments: [property, value]
          });
        }
      }

      if (headingStart !== undefined) {
        await this.workflowStep(session.sessionId, "emacs_navigate", { operation: "goto_position", position: headingStart });
      }
      const headingEnd = this.workflowRecord(await this.workflowStep(session.sessionId, "emacs_navigate", { operation: "line_end" }), "heading line navigation");
      const headingObserved = this.workflowRecord(headingEnd.observed, "heading line observed state");
      const headingCursor = this.workflowRecord(headingObserved.cursor, "heading line cursor");
      let insertionPoint = typeof headingCursor.point === "number" ? Math.floor(headingCursor.point) : undefined;
      if (insertionPoint === undefined) throw new OperatorError("E_INTERNAL", "Org heading navigation did not report point.");

      if (body !== undefined && body.length > 0) {
        const text = `\n${body}${body.endsWith("\n") ? "" : "\n"}`;
        const inserted = this.workflowRecord(await this.workflowStep(session.sessionId, "emacs_edit", {
          operation: "insert", position: insertionPoint, text
        }), "Org body insertion");
        const observed = this.workflowRecord(inserted.observed, "Org body observed state");
        const cursor = this.workflowRecord(observed.cursor, "Org body cursor");
        if (typeof cursor.point === "number") insertionPoint = Math.floor(cursor.point);
      }

      let tableResult: unknown;
      if (section.table !== undefined) {
        assertObject(section.table, "section.table");
        if (!Array.isArray(section.table.headers) || !Array.isArray(section.table.rows)) {
          throw new OperatorError("E_SCHEMA_VALIDATION", "Org table requires headers and rows arrays.");
        }
        await this.workflowStep(session.sessionId, "emacs_navigate", { operation: "goto_position", position: insertionPoint });
        tableResult = await this.workflowStep(session.sessionId, "emacs_command", {
          command: "emacs-operator-org-insert-table", interactive: false,
          arguments: [section.table.headers, section.table.rows]
        });
        const tableReturn = this.workflowRecord(this.workflowCommandReturn(tableResult), "Org table return value");
        const table = this.workflowRecord(tableReturn.table, "Org table metadata");
        const [, tableEnd] = this.workflowBounds(table.bounds, "Org table bounds");
        insertionPoint = tableEnd;
      }

      let sourceResult: unknown;
      let babelResult: Record<string, unknown> | undefined;
      if (source) {
        const language = requiredString(source, "language");
        const sourceBody = typeof source.body === "string" ? source.body : "";
        if (Buffer.byteLength(sourceBody, "utf8") > 262_144) {
          throw new OperatorError("E_INVALID_ARGUMENT", "Org source block exceeds the 256 KiB safety bound.");
        }
        await this.workflowStep(session.sessionId, "emacs_navigate", { operation: "goto_position", position: insertionPoint });
        sourceResult = await this.workflowStep(session.sessionId, "emacs_command", {
          command: "emacs-operator-org-insert-src-block", interactive: false,
          arguments: [language, sourceBody, typeof source.headers === "string" ? source.headers : ""]
        });
      }

      const validatedBeforeEval = await this.workflowStep(session.sessionId, "emacs_validate", {
        adapter: "org",
        options: args.validate_options && typeof args.validate_options === "object" ? args.validate_options : {}
      });
      const orgValidationBefore = this.workflowValidation(validatedBeforeEval, "org");
      if (orgValidationBefore.valid !== true) {
        return this.workflowProposalFailure(session.sessionId, checkpointId, "org_build_section", "validation_failed", {
          heading: headingReturn,
          validation: orgValidationBefore
        });
      }

      if (source && executeBabel) {
        const evaluated = await this.workflowStep(session.sessionId, "emacs_eval", {
          language: "buffer_language", operation: "execute_babel", adapter: "org",
          timeout_ms: typeof source.timeout_ms === "number" ? Math.min(30_000, Math.max(1, Math.floor(source.timeout_ms))) : 5_000
        });
        babelResult = this.workflowEvaluation(evaluated);
        if (babelResult.completed !== true) {
          return this.workflowProposalFailure(session.sessionId, checkpointId, "org_build_section", "babel_condition", {
            heading: headingReturn, validation: orgValidationBefore, evaluation: babelResult
          }, true);
        }
        if (source.expected_value !== undefined && String(babelResult.value) !== String(source.expected_value)) {
          return this.workflowProposalFailure(session.sessionId, checkpointId, "org_build_section", "unexpected_babel_value", {
            heading: headingReturn, validation: orgValidationBefore, evaluation: babelResult,
            expected_value: String(source.expected_value)
          }, true);
        }
      }

      const validatedAfter = await this.workflowStep(session.sessionId, "emacs_validate", {
        adapter: "org",
        options: args.validate_options && typeof args.validate_options === "object" ? args.validate_options : {}
      });
      const orgValidationAfter = this.workflowValidation(validatedAfter, "org");
      if (orgValidationAfter.valid !== true) {
        return this.workflowProposalFailure(session.sessionId, checkpointId, "org_build_section", "post_evaluation_validation_failed", {
          heading: headingReturn, validation: orgValidationAfter, ...(babelResult ? { evaluation: babelResult } : {})
        }, !!babelResult);
      }
      const commit = await this.workflowStep(session.sessionId, "emacs_checkpoint", { action: "commit", checkpoint_id: checkpointId });
      return {
        operation: "org_build_section",
        status: "committed",
        checkpoint_id: checkpointId,
        transaction_scope: this.workflowTransactionScope(!!babelResult),
        heading: headingReturn,
        ...(tableResult ? { table: this.workflowCommandReturn(tableResult) } : {}),
        ...(sourceResult ? { source_block: this.workflowCommandReturn(sourceResult) } : {}),
        ...(babelResult ? { evaluation: babelResult } : {}),
        validation: orgValidationAfter,
        commit
      };
    } catch (error) {
      try { await this.workflowRollback(session.sessionId, checkpointId); } catch (rollbackError) { throw rollbackError; }
      throw error;
    }
  }

  private verifyNativeExecution(observed: Record<string, unknown>, verify: unknown): Record<string, unknown> {
    if (!verify || typeof verify !== "object") return { matched: true };
    const expected = (verify as Record<string, unknown>).expected_command;
    if (typeof expected !== "string" || expected.length === 0) return { matched: true };
    const interaction = observed.interaction && typeof observed.interaction === "object" ? observed.interaction as Record<string, unknown> : {};
    const recent = Array.isArray(observed.recent_commands) ? observed.recent_commands : [];
    const first = recent[0] && typeof recent[0] === "object" ? recent[0] as Record<string, unknown> : undefined;
    const actual = typeof first?.command === "string" ? first.command : typeof interaction.last_command === "string" ? interaction.last_command : null;
    if (actual !== expected) {
      throw new OperatorError("E_COMMAND_FAILED", `Native key sequence completed but Emacs reported ${actual ?? "no command"} instead of ${expected}.`, {
        expected_command: expected,
        observed_command: actual
      });
    }
    return { matched: true, expected_command: expected, observed_command: actual };
  }

  private observeCompact(client: { request<T>(method: string, params: Record<string, unknown>): Promise<T> }, session: EmacsSession): Promise<Record<string, unknown>> {
    return client.request<Record<string, unknown>>("state.observe", {
      target: snakeTarget(session),
      scope: ["compact"],
      around_chars: 256
    });
  }
}
