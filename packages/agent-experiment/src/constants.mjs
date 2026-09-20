export const DRIVER_PROTOCOL = "emacs-operator.agent-driver/1";
export const EXPERIMENT_SCHEMA_VERSION = "1.0";
export const DEFAULT_TIMEOUT_MS = 180_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const DEFAULT_MAX_STDOUT_BYTES = 1_048_576;
export const DEFAULT_MAX_STDERR_BYTES = 1_048_576;
export const DEFAULT_MAX_EVENTS = 10_000;
export const SECRET_KEY_PATTERN = /(?:^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|password|private[_-]?key|secret)(?:$|[_-])/i;
export const SENSITIVE_ENV_PATTERN = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION|CREDENTIAL)/i;
export const SAFE_INHERITED_ENV = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "USER", "LOGNAME", "TERM", "COLORTERM", "SystemRoot", "ComSpec", "PATHEXT"
];
export const DEFAULT_CANDIDATE_TOOLS = [
  "emacs_instances", "emacs_session_open", "emacs_session_close", "emacs_observe",
  "emacs_read", "emacs_navigate", "emacs_capabilities", "emacs_key_sequence",
  "emacs_command", "emacs_edit", "emacs_eval", "emacs_validate", "emacs_analyze",
  "emacs_checkpoint", "emacs_rollback", "emacs_wait", "emacs_capture",
  "emacs_workflow", "emacs_project_rename", "emacs_verification"
];
