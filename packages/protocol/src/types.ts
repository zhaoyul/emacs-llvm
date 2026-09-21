export type ExecutionChannel = "semantic" | "internal_keys" | "native_keys";

export interface EmacsInstanceRecord {
  protocol_version: string;
  instance_id: string;
  pid: number;
  host: string;
  port: number;
  token_file: string;
  emacs_version: string;
  system_type: string;
  window_system: string | null;
  started_at: string;
  heartbeat_at: string;
  daemon?: boolean;
  gui_frame_count?: number;
  available_adapters?: string[];
}

export interface TargetSelector {
  instance_id?: string;
  file?: string;
  buffer_id?: string;
  buffer_name?: string;
  frame_id?: string;
  window_id?: string;
  project_root?: string;
}

export interface ResolvedTarget {
  frame_id?: string;
  frame_title?: string | null;
  native_window_identifier?: string | null;
  window_id?: string;
  buffer_id: string;
  buffer_name: string;
  file?: string | null;
  project_root?: string | null;
  major_mode: string;
}

export interface SessionCapabilities {
  channels: Record<ExecutionChannel, boolean>;
  features: Record<string, boolean | string | number | null>;
}

export interface EmacsSession {
  sessionId: string;
  instanceId: string;
  defaultChannel: ExecutionChannel;
  permissionProfile: string;
  target: {
    frameId?: string;
    frameTitle?: string;
    nativeWindowIdentifier?: string;
    windowId?: string;
    bufferId?: string;
    projectRoot?: string;
    file?: string;
  };
  capabilities: SessionCapabilities;
  stateSeqAtOpen: number;
  createdAt: string;
  lastUsedAt: string;
  leaseOwner: string;
}

export interface MutationPrecondition {
  expected_state_seq?: number;
  expected_buffer_id?: string;
  expected_buffer_tick?: number;
  expected_major_mode?: string;
  expected_frontmost_pid?: number;
}

export interface StateSummary {
  state_seq?: number;
  buffer_tick?: number;
  buffer_id?: string;
  major_mode?: string;
  point?: number;
}

export interface CanonicalKeyEvent {
  kind: "key_down" | "key_up" | "key_press" | "text";
  key?: string;
  code?: string;
  text?: string;
  modifiers?: Array<
    "control" | "meta" | "shift" | "super" | "hyper" | "alt" | "command" | "option" | "fn"
  >;
  repeat?: number;
  delayAfterMs?: number;
}

export type InternalKeyStep =
  | { kind: "keys"; value: string }
  | { kind: "text"; value: string }
  | { kind: "event"; event: CanonicalKeyEvent }
  | { kind: "expect"; condition: Record<string, unknown> };

export interface KeySequenceRequest {
  session_id: string;
  channel?: ExecutionChannel;
  steps: InternalKeyStep[];
  precondition?: MutationPrecondition;
  verify?: Record<string, unknown>;
  request_id?: string;
}

export interface AuditEntry {
  audit_id: string;
  request_id: string;
  session_id?: string;
  instance_id?: string;
  timestamp: string;
  tool: string;
  mutation: boolean;
  ok: boolean;
  error_code?: string;
  duration_ms: number;
  state_before?: StateSummary;
  state_after?: StateSummary;
}
