export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: true
});

const sessionId = { type: "string", minLength: 1 };

const workflowNavigationSchema = objectSchema({
  operation: { enum: ["goto_position", "goto_line", "buffer_start", "buffer_end", "line_start", "line_end", "search_forward", "search_backward", "forward_sexp", "backward_sexp", "beginning_of_defun", "end_of_defun", "up_list", "down_list"] },
  position: { type: "integer", minimum: 1 },
  line: { type: "integer", minimum: 1 },
  query: { type: "string", minLength: 1, maxLength: 8192 },
  regex: { type: "boolean" },
  case_sensitive: { type: "boolean" },
  count: { type: "integer", minimum: 1, maximum: 10000 },
  bound: { type: "integer", minimum: 1 }
}, ["operation"]);

const workflowEvaluationStepSchema = objectSchema({
  operation: { enum: ["eval_last_sexp", "eval_defun", "eval_region"] },
  adapter: { type: "string" },
  timeout_ms: { type: "integer", minimum: 1, maximum: 30000 },
  navigation: workflowNavigationSchema,
  expected_value: {}
}, ["operation"]);

const workflowEvaluationSchema = {
  oneOf: [
    workflowEvaluationStepSchema,
    objectSchema({ steps: { type: "array", minItems: 1, maxItems: 8, items: workflowEvaluationStepSchema } }, ["steps"])
  ]
};

const workflowEditSchema = objectSchema({
  operation: { enum: ["insert", "replace_range", "delete_range", "apply_unified_diff"] },
  position: { type: "integer", minimum: 1 },
  start: { type: "integer", minimum: 1 },
  end: { type: "integer", minimum: 1 },
  text: { type: "string" },
  diff: { type: "string" }
}, ["operation"]);

const workflowRangeSchema = objectSchema({
  start: { type: "integer", minimum: 1 },
  end: { type: "integer", minimum: 1 }
}, ["start", "end"]);

const workflowOrgRewriteSchema = objectSchema({
  expected_title: { type: "string", minLength: 1, maxLength: 8192 },
  title: { type: "string", minLength: 1, maxLength: 8192 },
  todo: { type: ["string", "null"] },
  tags: { type: "array", items: { type: "string" }, maxItems: 100 },
  properties: { type: "object", additionalProperties: { type: "string" } },
  body: { type: "string", maxLength: 262144 },
  move: objectSchema({
    direction: { enum: ["up", "down"] },
    count: { type: "integer", minimum: 1, maximum: 100 }
  }, ["direction"])
});

const workflowSectionSchema = objectSchema({
  title: { type: "string", minLength: 1, maxLength: 8192 },
  level: { type: "integer", minimum: 1, maximum: 50 },
  placement: { enum: ["buffer_end", "at_point"] },
  todo: { type: ["string", "null"] },
  tags: { type: "array", items: { type: "string" }, maxItems: 100 },
  properties: { type: "object", additionalProperties: { type: "string" } },
  body: { type: "string", maxLength: 262144 },
  table: objectSchema({
    headers: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
    rows: { type: "array", maxItems: 1000, items: { type: "array", items: { type: "string" } } }
  }, ["headers", "rows"]),
  source_block: objectSchema({
    language: { type: "string", minLength: 1 },
    body: { type: "string", maxLength: 262144 },
    headers: { type: "string" },
    execute: { type: "boolean" },
    expected_value: {},
    timeout_ms: { type: "integer", minimum: 1, maximum: 30000 }
  }, ["language", "body"])
}, ["title"]);

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "emacs_health",
    description: "Return Emacs Operator MCP server health and implementation capabilities.",
    inputSchema: objectSchema({})
  },
  {
    name: "emacs_instances",
    description: "Discover local Emacs instances exposing the Emacs Operator bridge.",
    inputSchema: objectSchema({})
  },
  {
    name: "emacs_session_open",
    description: "Open an explicit session and resolve a stable Emacs target.",
    inputSchema: objectSchema({
      selector: { type: "object" },
      default_channel: { enum: ["semantic", "internal_keys", "native_keys"] },
      permission_profile: { enum: ["read_only", "workspace_edit", "trusted_local"] },
      request_id: { type: "string" }
    }, ["selector"])
  },
  {
    name: "emacs_session_close",
    description: "Close an Emacs Operator session and release its mutation lease.",
    inputSchema: objectSchema({ session_id: sessionId, request_id: { type: "string" } }, ["session_id"])
  },
  {
    name: "emacs_observe",
    description: "Read structured Emacs state and bounded context for the session target.",
    inputSchema: objectSchema({ session_id: sessionId, scope: { type: "array", items: { type: "string" } }, around_chars: { type: "integer" }, since_state_seq: { type: "integer" }, request_id: { type: "string" } }, ["session_id"])
  },
  {
    name: "emacs_read",
    description: "Read an exact bounded slice of the session buffer with pagination metadata.",
    inputSchema: objectSchema({ session_id: sessionId, start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 }, max_chars: { type: "integer", minimum: 1, maximum: 262144 }, request_id: { type: "string" } }, ["session_id"])
  },
  {
    name: "emacs_navigate",
    description: "Move point semantically in the target buffer without mutating text or requiring a foreground window.",
    inputSchema: objectSchema({
      session_id: sessionId,
      operation: { enum: ["goto_position", "goto_line", "buffer_start", "buffer_end", "line_start", "line_end", "search_forward", "search_backward", "forward_sexp", "backward_sexp", "beginning_of_defun", "end_of_defun", "up_list", "down_list"] },
      position: { type: "integer", minimum: 1 }, line: { type: "integer", minimum: 1 },
      query: { type: "string", minLength: 1, maxLength: 8192 }, regex: { type: "boolean" }, case_sensitive: { type: "boolean" },
      count: { type: "integer", minimum: 1, maximum: 10000 }, bound: { type: "integer", minimum: 1 },
      precondition: { type: "object" }, request_id: { type: "string" }
    }, ["session_id", "operation"])
  },
  {
    name: "emacs_capabilities",
    description: "Resolve key bindings, commands, features and mode capabilities in the target context.",
    inputSchema: objectSchema({ session_id: sessionId, operation: { type: "string" }, key: { type: "string" }, command: { type: "string" }, feature: { type: "string" }, adapter: { type: "string" }, request_id: { type: "string" } }, ["session_id", "operation"])
  },
  {
    name: "emacs_validate",
    description: "Run read-only adapter structural validation and return machine-readable diagnostics without mutating the buffer.",
    inputSchema: objectSchema({ session_id: sessionId, adapter: { type: "string" }, options: { type: "object" }, request_id: { type: "string" } }, ["session_id"])
  },
  {
    name: "emacs_analyze",
    description: "Run a read-only mode-aware analyzer against code already present in the target buffer. Analysis is mutation-guarded by the Emacs bridge.",
    inputSchema: objectSchema({
      session_id: sessionId,
      adapter: { type: "string", minLength: 1, maxLength: 128 },
      operation: { type: "string", minLength: 1, maxLength: 128 },
      params: { type: "object" },
      request_id: { type: "string" }
    }, ["session_id", "operation"])
  },
  {
    name: "emacs_verification",
    description: "Run and guard a structured buffer-derived Lisp/REPL verification ticket. Reruns require changed source and obey side-effect risk and attempt caps.",
    inputSchema: objectSchema({
      session_id: sessionId,
      action: { enum: ["start", "rerun", "status", "close"] },
      ticket_id: { type: "string", minLength: 1, maxLength: 256 },
      adapter: { type: "string", minLength: 1, maxLength: 128 },
      operation: { enum: ["eval_last_sexp", "eval_defun", "eval_region"] },
      timeout_ms: { type: "integer", minimum: 1, maximum: 30000 },
      max_attempts: { type: "integer", minimum: 1, maximum: 3 },
      side_effect_risk: { enum: ["low", "high", "unknown"] },
      allow_risky_rerun: { type: "boolean" },
      request_id: { type: "string" }
    }, ["session_id", "action"])
  },
  {
    name: "emacs_project_rename",
    description: "Run an analysis-first, language-aware, xref-backed project rename lifecycle: plan, bounded preview, apply to live buffers, rollback by journal, or commit the rollback journal. Clojure namespace and Common Lisp package qualification can be preserved explicitly. Apply never saves files.",
    inputSchema: objectSchema({
      session_id: sessionId,
      action: { enum: ["plan", "preview", "apply", "status", "rollback", "commit"] },
      old_symbol: { type: "string", minLength: 1, maxLength: 256 },
      new_symbol: { type: "string", minLength: 1, maxLength: 256 },
      language: { enum: ["generic", "elisp", "clojure", "common_lisp"] },
      qualification_policy: { enum: ["exact", "preserve_qualification", "leaf_only"] },
      include_definitions: { type: "boolean" },
      plan_id: { type: "string", minLength: 1, maxLength: 256 },
      journal_id: { type: "string", minLength: 1, maxLength: 256 },
      max_preview_edits: { type: "integer", minimum: 1, maximum: 200 },
      precondition: { type: "object" },
      request_id: { type: "string" }
    }, ["session_id", "action"])
  },
  {
    name: "emacs_key_sequence",
    description: "Execute a complete key/text sequence through internal Emacs events or a native driver.",
    inputSchema: objectSchema({ session_id: sessionId, channel: { enum: ["internal_keys", "native_keys"] }, steps: { type: "array", minItems: 1 }, precondition: { type: "object" }, verify: { type: "object" }, restore_frontmost: { type: "boolean" }, request_id: { type: "string" } }, ["session_id", "steps"])
  },
  {
    name: "emacs_command",
    description: "Execute an interactive Emacs command in the explicit session target.",
    inputSchema: objectSchema({ session_id: sessionId, command: { type: "string" }, interactive: { type: "boolean" }, prefix: {}, arguments: { type: "array" }, precondition: { type: "object" }, request_id: { type: "string" } }, ["session_id", "command"])
  },
  {
    name: "emacs_edit",
    description: "Perform exact semantic insert, replace, delete or unified-diff edits with state preconditions.",
    inputSchema: objectSchema({ session_id: sessionId, operation: { enum: ["insert", "replace_range", "delete_range", "apply_unified_diff"] }, position: { type: "integer" }, start: { type: "integer" }, end: { type: "integer" }, text: { type: "string" }, diff: { type: "string" }, precondition: { type: "object" }, request_id: { type: "string" } }, ["session_id", "operation"])
  },
  {
    name: "emacs_eval",
    description: "Execute policy-controlled, buffer-derived structured evaluation. Caller-supplied source strings are rejected in this build.",
    inputSchema: objectSchema({ session_id: sessionId, language: { enum: ["elisp", "buffer_language", "repl"] }, code: { type: "string" }, operation: { type: "string" }, adapter: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 30000 }, precondition: { type: "object" }, request_id: { type: "string" } }, ["session_id", "language"])
  },
  {
    name: "emacs_workflow",
    description: "Run an allowlisted high-level semantic buffer transaction with automatic checkpoint, validation, evaluation/verification, and commit or rollback. Buffer rollback is checkpoint-managed; Lisp/REPL/Babel runtime side effects are explicitly not transactional.",
    inputSchema: objectSchema({
      session_id: sessionId,
      operation: { enum: ["repair_lisp", "refactor_defun", "rename_symbol", "extract_function", "move_form", "transform_sexp", "org_build_section", "org_rewrite_subtree"] },
      edit: workflowEditSchema,
      replacement: { type: "string", maxLength: 262144 },
      expected_name: { type: "string" },
      old_symbol: { type: "string", minLength: 1, maxLength: 512 },
      new_symbol: { type: "string", minLength: 1, maxLength: 512 },
      scope: { enum: ["current_defun", "buffer"] },
      max_replacements: { type: "integer", minimum: 1, maximum: 10000 },
      range: workflowRangeSchema,
      name: { type: "string", minLength: 1, maxLength: 512 },
      parameters: { type: "array", maxItems: 128, items: { type: "string", minLength: 1, maxLength: 512 } },
      evaluate_definition: { type: "boolean" },
      evaluate_enclosing_definition: { type: "boolean" },
      direction: { enum: ["up", "down", "backward", "forward"] },
      count: { type: "integer", minimum: 1, maximum: 100 },
      transform: { enum: ["slurp_forward", "barf_forward", "splice", "wrap_round", "raise", "split", "join", "indent_defun"] },
      evaluation: workflowEvaluationSchema,
      section: workflowSectionSchema,
      rewrite: workflowOrgRewriteSchema,
      validate_options: { type: "object" },
      precondition: { type: "object" },
      request_id: { type: "string" }
    }, ["session_id", "operation"])
  },
  {
    name: "emacs_checkpoint",
    description: "Create or commit an in-memory checkpoint for safe rollback.",
    inputSchema: objectSchema({ session_id: sessionId, action: { enum: ["create", "commit"] }, checkpoint_id: { type: "string" }, scope: { enum: ["buffer", "buffers", "files"] }, request_id: { type: "string" } }, ["session_id"])
  },
  {
    name: "emacs_rollback",
    description: "Rollback a checkpoint unless human edits or external file changes conflict.",
    inputSchema: objectSchema({ session_id: sessionId, checkpoint_id: { type: "string" }, request_id: { type: "string" } }, ["session_id", "checkpoint_id"])
  },
  {
    name: "emacs_wait",
    description: "Wait for a bounded Emacs state predicate without fixed sleeps.",
    inputSchema: objectSchema({ session_id: sessionId, condition: { type: "object" }, timeout_ms: { type: "integer", minimum: 1, maximum: 10000 }, request_id: { type: "string" } }, ["session_id", "condition"])
  },
  {
    name: "emacs_capture",
    description: "Capture a selected Emacs frame/window when a native platform driver is available.",
    inputSchema: objectSchema({ session_id: sessionId, window_title: { type: "string" }, window_identifier: { type: "string" }, max_width: { type: "integer" }, include_cursor: { type: "boolean" }, request_id: { type: "string" } }, ["session_id"])
  }
];
