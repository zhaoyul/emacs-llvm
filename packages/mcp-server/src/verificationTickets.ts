import crypto from "node:crypto";
import { OperatorError } from "../../protocol/src/errors.js";

export type VerificationRisk = "low" | "high" | "unknown";

export interface VerificationAttempt {
  adapter?: string | null;
  completed: boolean;
  value?: unknown;
  condition?: unknown;
  stderr?: unknown;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface VerificationTicket {
  ticketId: string;
  sessionId: string;
  adapter?: string | null;
  operation: string;
  timeoutMs: number;
  maxAttempts: number;
  sideEffectRisk: VerificationRisk;
  allowRiskyRerun: boolean;
  attempts: VerificationAttempt[];
  createdAt: number;
  expiresAt: number;
}

export class VerificationTicketManager {
  private readonly tickets = new Map<string, VerificationTicket>();
  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxTickets = 100,
    private readonly now: () => number = Date.now
  ) {}

  private prune(): void {
    const current = this.now();
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt <= current) this.tickets.delete(id);
    }
    while (this.tickets.size >= this.maxTickets) {
      const oldest = this.tickets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tickets.delete(oldest);
    }
  }

  create(input: Omit<VerificationTicket, "ticketId" | "createdAt" | "expiresAt">): VerificationTicket {
    this.prune();
    const createdAt = this.now();
    const ticket: VerificationTicket = {
      ...input,
      attempts: [...input.attempts],
      ticketId: `verify_${crypto.randomUUID()}`,
      createdAt,
      expiresAt: createdAt + this.ttlMs
    };
    this.tickets.set(ticket.ticketId, ticket);
    return ticket;
  }

  get(ticketId: string, sessionId: string): VerificationTicket {
    this.prune();
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new OperatorError("E_TRANSACTION_NOT_FOUND", "Unknown or expired verification ticket.", { ticket_id: ticketId });
    if (ticket.sessionId !== sessionId) throw new OperatorError("E_POLICY_DENIED", "Verification ticket belongs to a different session.");
    return ticket;
  }

  append(ticketId: string, sessionId: string, attempt: VerificationAttempt): VerificationTicket {
    const ticket = this.get(ticketId, sessionId);
    ticket.attempts.push(attempt);
    ticket.expiresAt = this.now() + this.ttlMs;
    return ticket;
  }

  close(ticketId: string, sessionId: string): void {
    this.get(ticketId, sessionId);
    this.tickets.delete(ticketId);
  }
}
