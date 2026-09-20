import crypto from "node:crypto";
import { OperatorError } from "../../../protocol/src/errors.js";
import type { EmacsSession, ExecutionChannel, ResolvedTarget, SessionCapabilities } from "../../../protocol/src/types.js";

interface SessionOpenInput {
  instanceId: string;
  defaultChannel: ExecutionChannel;
  permissionProfile: string;
  target: ResolvedTarget;
  capabilities: SessionCapabilities;
  stateSeqAtOpen: number;
  leaseOwner?: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, EmacsSession>();
  private readonly mutationOwners = new Map<string, string>();

  constructor(
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly now: () => number = () => Date.now()
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new RangeError("Session TTL must be a positive finite number.");
  }

  open(input: SessionOpenInput): EmacsSession {
    const now = this.nowISO();
    const sessionId = `ses_${crypto.randomUUID()}`;
    const target: EmacsSession["target"] = { bufferId: input.target.buffer_id };
    if (input.target.frame_id !== undefined) target.frameId = input.target.frame_id;
    if (input.target.frame_title !== undefined && input.target.frame_title !== null) target.frameTitle = input.target.frame_title;
    if (input.target.native_window_identifier !== undefined && input.target.native_window_identifier !== null) target.nativeWindowIdentifier = input.target.native_window_identifier;
    if (input.target.window_id !== undefined) target.windowId = input.target.window_id;
    if (input.target.project_root !== undefined && input.target.project_root !== null) target.projectRoot = input.target.project_root;
    if (input.target.file !== undefined && input.target.file !== null) target.file = input.target.file;
    const session: EmacsSession = {
      sessionId,
      instanceId: input.instanceId,
      defaultChannel: input.defaultChannel,
      permissionProfile: input.permissionProfile,
      target,
      capabilities: input.capabilities,
      stateSeqAtOpen: input.stateSeqAtOpen,
      createdAt: now,
      lastUsedAt: now,
      leaseOwner: input.leaseOwner ?? "mcp-client"
    };
    this.sessions.set(sessionId, session);
    return structuredClone(session);
  }

  get(sessionId: string): EmacsSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new OperatorError("E_SESSION_NOT_FOUND", `Session ${sessionId} does not exist.`);
    const age = this.now() - Date.parse(session.lastUsedAt);
    if (age > this.ttlMs) {
      this.close(sessionId);
      throw new OperatorError("E_SESSION_EXPIRED", `Session ${sessionId} expired.`);
    }
    session.lastUsedAt = this.nowISO();
    return structuredClone(session);
  }

  updateTarget(sessionId: string, target: ResolvedTarget): EmacsSession {
    const session = this.requireMutable(sessionId);
    session.target.bufferId = target.buffer_id;
    if (target.frame_id !== undefined) session.target.frameId = target.frame_id;
    else delete session.target.frameId;
    if (target.frame_title !== undefined && target.frame_title !== null) session.target.frameTitle = target.frame_title;
    else delete session.target.frameTitle;
    if (target.native_window_identifier !== undefined && target.native_window_identifier !== null) session.target.nativeWindowIdentifier = target.native_window_identifier;
    else delete session.target.nativeWindowIdentifier;
    if (target.window_id !== undefined) session.target.windowId = target.window_id;
    else delete session.target.windowId;
    if (target.file !== undefined && target.file !== null) session.target.file = target.file;
    else delete session.target.file;
    if (target.project_root !== undefined && target.project_root !== null) session.target.projectRoot = target.project_root;
    else delete session.target.projectRoot;
    session.lastUsedAt = this.nowISO();
    return structuredClone(session);
  }

  acquireMutation(sessionId: string): void {
    const session = this.requireMutable(sessionId);
    const owner = this.mutationOwners.get(session.instanceId);
    if (owner && owner !== sessionId) {
      throw new OperatorError("E_MUTATION_LOCKED", "Another session owns the mutation lease for this Emacs instance.", {
        instance_id: session.instanceId,
        owner_session_id: owner
      });
    }
    this.mutationOwners.set(session.instanceId, sessionId);
  }

  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (this.mutationOwners.get(session.instanceId) === sessionId) this.mutationOwners.delete(session.instanceId);
    this.sessions.delete(sessionId);
    return true;
  }

  list(): EmacsSession[] {
    this.pruneExpired();
    return [...this.sessions.values()].map((session) => structuredClone(session));
  }

  private requireMutable(sessionId: string): EmacsSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new OperatorError("E_SESSION_NOT_FOUND", `Session ${sessionId} does not exist.`);
    const age = this.now() - Date.parse(session.lastUsedAt);
    if (age > this.ttlMs) {
      this.close(sessionId);
      throw new OperatorError("E_SESSION_EXPIRED", `Session ${sessionId} expired.`);
    }
    session.lastUsedAt = this.nowISO();
    return session;
  }

  private nowISO(): string {
    return new Date(this.now()).toISOString();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - Date.parse(session.lastUsedAt) > this.ttlMs) this.close(sessionId);
    }
  }
}
