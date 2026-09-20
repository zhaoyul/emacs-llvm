
export interface BenchmarkAgentProfile {
  schema_version: "1.0";
  id: string;
  revision: string;
  label: string;
  kind: "deterministic_harness_probe" | "llm_experiment" | "custom";
  tool_profile: string;
  prompt_policy: string;
  pairing_key?: string;
  provider?: string;
  model?: string;
  model_version?: string;
  temperature?: number;
  top_p?: number;
  max_context_tokens?: number;
  cross_trial_memory?: "disabled" | "enabled" | "unknown";
  network_access?: "disabled" | "enabled" | "unknown";
  description?: string;
  notes?: string[];
}

export interface LoadedBenchmarkAgentProfile {
  profile: BenchmarkAgentProfile;
  path: string;
  digest: string;
}

export type BenchmarkDomain = "elisp" | "clojure" | "common_lisp" | "org" | "mixed";
export type BenchmarkCategory = "repair" | "refactor" | "authoring" | "navigation" | "evaluation";
export type BenchmarkDifficulty = "small" | "medium" | "large";

export interface BenchmarkSuiteDefaults {
  timeout_ms?: number;
  trials?: number;
  pass_threshold?: number;
  max_workspace_bytes?: number;
  max_agent_output_bytes?: number;
}

export interface BenchmarkRequirement {
  executables?: string[];
  platforms?: string[];
  environment?: string[];
}

export interface BenchmarkCheckBase {
  id: string;
  type: string;
  weight?: number;
  required?: boolean;
  description?: string;
}

export interface FileExistsCheck extends BenchmarkCheckBase {
  type: "file_exists";
  path: string;
}

export interface FileUnchangedCheck extends BenchmarkCheckBase {
  type: "file_unchanged";
  path: string;
}

export interface TextContainsCheck extends BenchmarkCheckBase {
  type: "text_contains";
  path: string;
  text: string;
  min_count?: number;
}

export interface TextNotContainsCheck extends BenchmarkCheckBase {
  type: "text_not_contains";
  path: string;
  text: string;
}

export interface RegexCountCheck extends BenchmarkCheckBase {
  type: "regex_count";
  path: string;
  pattern: string;
  flags?: string;
  min_count?: number;
  max_count?: number;
}

export interface ExactTextCheck extends BenchmarkCheckBase {
  type: "exact_text";
  path: string;
  expected_text?: string;
  expected_file?: string;
  normalize_final_newline?: boolean;
}

export interface LispBalanceCheck extends BenchmarkCheckBase {
  type: "lisp_balance";
  path: string;
}

export interface OrgStructureExpectation {
  min_headings?: number;
  exact_headings?: number;
  required_titles?: string[];
  min_tables?: number;
  exact_tables?: number;
  min_src_blocks?: number;
  exact_src_blocks?: number;
  required_languages?: string[];
  required_properties?: Record<string, string>;
}

export interface OrgStructureCheck extends BenchmarkCheckBase {
  type: "org_structure";
  path: string;
  expect: OrgStructureExpectation;
}

export interface CommandCheck extends BenchmarkCheckBase {
  type: "command";
  command: string[];
  cwd?: string;
  timeout_ms?: number;
  expected_exit_code?: number;
  stdout_contains?: string;
  stderr_contains?: string;
}

export type BenchmarkCheck =
  | FileExistsCheck
  | FileUnchangedCheck
  | TextContainsCheck
  | TextNotContainsCheck
  | RegexCountCheck
  | ExactTextCheck
  | LispBalanceCheck
  | OrgStructureCheck
  | CommandCheck;

export interface BenchmarkTask {
  id: string;
  title: string;
  domain: BenchmarkDomain;
  category: BenchmarkCategory;
  difficulty: BenchmarkDifficulty;
  prompt_file: string;
  fixture_dir: string;
  description?: string;
  tags?: string[];
  requirements?: BenchmarkRequirement;
  checks: BenchmarkCheck[];
  protected_paths?: string[];
  allowed_paths?: string[];
  pass_threshold?: number;
  timeout_ms?: number;
}

export interface BenchmarkSuite {
  schema_version: "1.0";
  id: string;
  revision: string;
  title: string;
  description?: string;
  defaults?: BenchmarkSuiteDefaults;
  tasks: BenchmarkTask[];
}

export interface LoadedBenchmarkTask {
  task: BenchmarkTask;
  prompt: string;
  prompt_path: string;
  fixture_path: string;
  digest: string;
}

export interface LoadedBenchmarkSuite {
  suite: BenchmarkSuite;
  suite_path: string;
  suite_dir: string;
  digest: string;
  tasks: LoadedBenchmarkTask[];
}

export type AgentRunStatus = "completed" | "failed" | "refused" | "timeout" | "protocol_error";

export type BenchmarkTraceKind =
  | "agent_started"
  | "agent_finished"
  | "tool_call"
  | "tool_result"
  | "validation"
  | "evaluation"
  | "rollback"
  | "note";

export interface BenchmarkTraceEvent {
  sequence?: number;
  at_ms: number;
  kind: BenchmarkTraceKind;
  tool?: string;
  operation?: string;
  channel?: "semantic" | "internal_keys" | "native_keys" | "filesystem" | "other";
  mutation?: boolean;
  ok?: boolean;
  duration_ms?: number;
  error_code?: string;
  input_tokens?: number;
  output_tokens?: number;
}

export interface BenchmarkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  tool_calls?: number;
  mutations?: number;
  rollbacks?: number;
}

export interface BenchmarkAgentRequest {
  protocol_version: "1.0";
  run_id: string;
  suite_id: string;
  suite_revision: string;
  suite_digest: string;
  task_id: string;
  task_digest: string;
  trial: number;
  /**
   * Stable per-task/per-trial seed derived from the suite digest and the
   * run-level seed. Baseline and candidate agents receive the same value in a
   * paired experiment, independent of execution order or run id.
   */
  trial_seed: number;
  prompt: string;
  workspace: string;
  timeout_ms: number;
  trace_path: string;
  metadata: {
    domain: BenchmarkDomain;
    category: BenchmarkCategory;
    difficulty: BenchmarkDifficulty;
    tags: string[];
  };
}

export interface BenchmarkAgentResult {
  protocol_version: "1.0";
  status: AgentRunStatus;
  summary?: string;
  usage?: BenchmarkUsage;
  events?: BenchmarkTraceEvent[];
}

export interface BenchmarkAgent {
  readonly id: string;
  readonly version: string | undefined;
  readonly mode: string;
  run(request: BenchmarkAgentRequest, signal?: AbortSignal): Promise<BenchmarkAgentResult>;
  descriptor?(): Record<string, unknown>;
}

export type CheckStatus = "pass" | "fail" | "error" | "skipped";

export interface BenchmarkCheckResult {
  id: string;
  type: string;
  status: CheckStatus;
  required: boolean;
  weight: number;
  description?: string;
  details?: Record<string, unknown>;
  duration_ms: number;
}

export interface WorkspaceFileRecord {
  path: string;
  bytes: number;
  sha256: string;
  mode: number;
}

export interface WorkspaceSnapshot {
  digest: string;
  total_bytes: number;
  files: WorkspaceFileRecord[];
}

export interface WorkspaceDiffSummary {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: number;
  changed_files: number;
  bytes_before: number;
  bytes_after: number;
}

export interface BenchmarkProcessMetrics {
  duration_ms: number;
  tool_calls: number;
  mutations: number;
  rollbacks: number;
  tool_errors: number;
  validations: number;
  evaluations: number;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface BenchmarkScore {
  score: number;
  threshold: number;
  passed_weight: number;
  total_weight: number;
  required_checks_passed: boolean;
  agent_completed: boolean;
  protected_paths_clean: boolean;
  allowed_paths_clean: boolean;
  passed: boolean;
  checks: BenchmarkCheckResult[];
}

export type BenchmarkTrialStatus = "passed" | "failed" | "agent_error" | "timeout" | "harness_error";

export interface BenchmarkTrialReport {
  trial_id: string;
  task_id: string;
  task_digest: string;
  trial: number;
  trial_seed: number;
  status: BenchmarkTrialStatus;
  agent_status: AgentRunStatus;
  agent_summary?: string;
  started_at: string;
  duration_ms: number;
  workspace_before: { digest: string; total_bytes: number; files: number };
  workspace_after: { digest: string; total_bytes: number; files: number };
  workspace_diff: WorkspaceDiffSummary;
  protected_path_violations: string[];
  unauthorized_path_violations: string[];
  workspace_retained: boolean;
  workspace_path?: string;
  score: BenchmarkScore;
  metrics: BenchmarkProcessMetrics;
  error?: { code: string; message: string };
}

export interface BenchmarkTaskSummary {
  task_id: string;
  task_digest: string;
  title: string;
  domain: BenchmarkDomain;
  category: BenchmarkCategory;
  difficulty: BenchmarkDifficulty;
  available: boolean;
  unavailable_reasons: string[];
  trials_requested: number;
  trials_executed: number;
  passed: number;
  failed: number;
  pass_rate: number | null;
  mean_score: number | null;
  mean_duration_ms: number | null;
}

export interface BenchmarkAggregate {
  tasks_total: number;
  tasks_available: number;
  tasks_unavailable: number;
  trials_requested: number;
  trials_executed: number;
  trials_passed: number;
  trials_failed: number;
  pass_rate: number | null;
  mean_score: number | null;
  median_score: number | null;
  mean_duration_ms: number | null;
  mean_tool_calls: number | null;
  mean_mutations: number | null;
  mean_rollbacks: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  protected_path_violations: number;
  unauthorized_path_violations: number;
}

export interface BenchmarkReport {
  schema_version: "1.0";
  kind: "emacs_operator_benchmark_report";
  runner_version: string;
  run_id: string;
  created_at: string;
  suite: { id: string; revision: string; title: string; digest: string };
  agent: { id: string; version?: string; mode: string; descriptor?: Record<string, unknown> };
  options: {
    trials: number;
    seed: number;
    allow_command_checks: boolean;
    require_all_tasks: boolean;
    preserve_workspaces: boolean;
  };
  environment: { platform: string; arch: string; node: string; cpus: number | null };
  integrity: {
    oracle_fields_excluded_from_request: true;
    agent_process_os_sandboxed: false;
    command_checks_explicitly_enabled: boolean;
    command_checks_use_disposable_workspace_copy: true;
    command_process_os_sandboxed: false;
    note: string;
  };
  tasks: BenchmarkTaskSummary[];
  trials: BenchmarkTrialReport[];
  aggregate: BenchmarkAggregate;
  ok: boolean;
  errors: Array<{ code: string; message: string }>;
}

export interface BenchmarkRunOptions {
  trials?: number;
  seed?: number;
  work_root?: string;
  allow_command_checks?: boolean;
  require_all_tasks?: boolean;
  preserve_workspaces?: boolean;
  output_path?: string;
  task_ids?: string[];
}

export interface BenchmarkComparisonPair {
  task_id: string;
  trial: number;
  trial_seed: number;
  baseline: { passed: boolean; score: number; duration_ms: number };
  candidate: { passed: boolean; score: number; duration_ms: number };
  outcome: "candidate_win" | "baseline_win" | "tie";
}

export interface BenchmarkComparisonReport {
  schema_version: "1.0";
  kind: "emacs_operator_benchmark_comparison";
  created_at: string;
  suite: { id: string; revision: string; digest: string };
  baseline: { run_id: string; agent_id: string; agent_version?: string };
  candidate: { run_id: string; agent_id: string; agent_version?: string };
  pairs: BenchmarkComparisonPair[];
  summary: {
    paired_trials: number;
    candidate_wins: number;
    baseline_wins: number;
    ties: number;
    candidate_advantage: number | null;
    bootstrap_95_ci: [number, number] | null;
    baseline_pass_rate: number | null;
    candidate_pass_rate: number | null;
    baseline_mean_score: number | null;
    candidate_mean_score: number | null;
  };
  interpretation: string;
}
