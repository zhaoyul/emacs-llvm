export const ERROR_CODES = [
  "E_INVALID_ARGUMENT",
  "E_SCHEMA_VALIDATION",
  "E_AUTH_FAILED",
  "E_INSTANCE_NOT_FOUND",
  "E_EMACS_DISCONNECTED",
  "E_SESSION_NOT_FOUND",
  "E_SESSION_EXPIRED",
  "E_TARGET_NOT_FOUND",
  "E_TARGET_STALE",
  "E_STATE_CONFLICT",
  "E_ANALYSIS_UNRESOLVED",
  "E_MUTATION_LOCKED",
  "E_PERMISSION_DENIED",
  "E_POLICY_DENIED",
  "E_COMMAND_NOT_FOUND",
  "E_COMMAND_NOT_INTERACTIVE",
  "E_COMMAND_FAILED",
  "E_COMMAND_QUIT",
  "E_KEY_PARSE_FAILED",
  "E_KEY_UNBOUND",
  "E_MINIBUFFER_UNEXPECTED",
  "E_COMMAND_TIMEOUT",
  "E_WAIT_TIMEOUT",
  "E_TRANSACTION_NOT_FOUND",
  "E_TRANSACTION_CONFLICT",
  "E_ROLLBACK_FAILED",
  "E_NATIVE_DRIVER_UNAVAILABLE",
  "E_ACCESSIBILITY_NOT_GRANTED",
  "E_SCREEN_CAPTURE_NOT_GRANTED",
  "E_FOCUS_FAILED",
  "E_FRONTMOST_MISMATCH",
  "E_USER_INTERFERENCE",
  "E_INPUT_INJECTION_FAILED",
  "E_CAPTURE_FAILED",
  "E_EXTERNAL_SIDE_EFFECT",
  "E_INTERNAL"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface OperatorErrorShape {
  code: ErrorCode;
  category: number;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  recovery: string;
}

const defaults: Record<ErrorCode, Omit<OperatorErrorShape, "code" | "message" | "details">> = {
  E_INVALID_ARGUMENT: { category: 400, retryable: false, recovery: "Correct the tool arguments and retry." },
  E_SCHEMA_VALIDATION: { category: 400, retryable: false, recovery: "Send arguments that match the published schema." },
  E_AUTH_FAILED: { category: 401, retryable: false, recovery: "Rediscover the Emacs instance and reconnect using its current token." },
  E_INSTANCE_NOT_FOUND: { category: 404, retryable: true, recovery: "Call emacs_instances and select a live instance." },
  E_EMACS_DISCONNECTED: { category: 503, retryable: true, recovery: "Rediscover the Emacs instance and reopen the session." },
  E_SESSION_NOT_FOUND: { category: 404, retryable: true, recovery: "Open a new Emacs session." },
  E_SESSION_EXPIRED: { category: 410, retryable: true, recovery: "Open a new Emacs session." },
  E_TARGET_NOT_FOUND: { category: 404, retryable: true, recovery: "Observe available targets or reopen the session with a valid selector." },
  E_TARGET_STALE: { category: 409, retryable: true, recovery: "Re-resolve the target and retry." },
  E_STATE_CONFLICT: { category: 409, retryable: true, recovery: "Call emacs_observe and re-plan the mutation from the new state." },
  E_ANALYSIS_UNRESOLVED: { category: 422, retryable: true, recovery: "Narrow the analyzed forms or provide explicitly reviewed parameters instead of guessing." },
  E_MUTATION_LOCKED: { category: 423, retryable: true, recovery: "Close the competing mutation session or wait for its lease to be released." },
  E_PERMISSION_DENIED: { category: 403, retryable: false, recovery: "Grant the required operating-system permission or use a non-native channel." },
  E_POLICY_DENIED: { category: 403, retryable: false, recovery: "Use an allowed operation or open a session with an explicitly authorized profile." },
  E_COMMAND_NOT_FOUND: { category: 404, retryable: true, recovery: "Query capabilities and resolve an available command." },
  E_COMMAND_NOT_INTERACTIVE: { category: 400, retryable: false, recovery: "Use an interactive command or an allowlisted semantic function." },
  E_COMMAND_FAILED: { category: 422, retryable: true, recovery: "Observe Emacs state and command messages before retrying." },
  E_COMMAND_QUIT: { category: 409, retryable: true, recovery: "Observe state. Retry only if the interruption was expected." },
  E_KEY_PARSE_FAILED: { category: 400, retryable: false, recovery: "Use valid Emacs kbd notation or structured key events." },
  E_KEY_UNBOUND: { category: 422, retryable: true, recovery: "Resolve the key binding in the target buffer before retrying." },
  E_MINIBUFFER_UNEXPECTED: { category: 409, retryable: true, recovery: "Observe the minibuffer prompt and provide a complete self-contained key flow." },
  E_COMMAND_TIMEOUT: { category: 504, retryable: true, recovery: "Inspect Emacs state and retry with an appropriate bounded wait." },
  E_WAIT_TIMEOUT: { category: 504, retryable: true, recovery: "Observe current state and adjust the wait predicate or timeout." },
  E_TRANSACTION_NOT_FOUND: { category: 404, retryable: false, recovery: "Create a new checkpoint." },
  E_TRANSACTION_CONFLICT: { category: 409, retryable: true, recovery: "Preserve user changes, observe state, and create a new checkpoint if appropriate." },
  E_ROLLBACK_FAILED: { category: 409, retryable: false, recovery: "Do not overwrite external changes. Resolve the conflict manually." },
  E_NATIVE_DRIVER_UNAVAILABLE: { category: 503, retryable: false, recovery: "Use semantic/internal_keys or install and start the platform host." },
  E_ACCESSIBILITY_NOT_GRANTED: { category: 403, retryable: true, recovery: "Grant the platform-specific desktop input/focus permission or use internal_keys." },
  E_SCREEN_CAPTURE_NOT_GRANTED: { category: 403, retryable: true, recovery: "Grant the platform-specific window-capture permission or use semantic observation." },
  E_FOCUS_FAILED: { category: 409, retryable: true, recovery: "Verify the target Emacs process/window still exists and retry." },
  E_FRONTMOST_MISMATCH: { category: 409, retryable: true, recovery: "Reacquire the desktop lease, refocus Emacs, and verify the PID." },
  E_USER_INTERFERENCE: { category: 409, retryable: true, recovery: "Stop native input, release modifiers, and retry only after the desktop is idle." },
  E_INPUT_INJECTION_FAILED: { category: 500, retryable: true, recovery: "Release all modifiers, verify permissions, and retry." },
  E_CAPTURE_FAILED: { category: 500, retryable: true, recovery: "Verify screen-capture permissions and target window state." },
  E_EXTERNAL_SIDE_EFFECT: { category: 409, retryable: false, recovery: "Review the irreversible side effect before taking further action." },
  E_INTERNAL: { category: 500, retryable: true, recovery: "Inspect audit metadata and retry only after observing current Emacs state." }
};

export class OperatorError extends Error {
  readonly code: ErrorCode;
  readonly category: number;
  readonly retryable: boolean;
  readonly recovery: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "OperatorError";
    const base = defaults[code];
    this.code = code;
    this.category = base.category;
    this.retryable = base.retryable;
    this.recovery = base.recovery;
    if (details !== undefined) this.details = details;
  }

  toJSON(): OperatorErrorShape {
    const value: OperatorErrorShape = {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      recovery: this.recovery
    };
    if (this.details !== undefined) value.details = this.details;
    return value;
  }
}

export function asOperatorError(error: unknown): OperatorError {
  if (error instanceof OperatorError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new OperatorError("E_INTERNAL", message);
}
