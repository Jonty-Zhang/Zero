/** Stable contracts shared by the Zero core and its orchestration layer. */

export type TaskStatus =
  | "pending"
  | "running"
  | "reviewing"
  | "revision"
  | "waiting"
  | "recovery_required"
  | "done"
  | "failed";

export interface CheckDefinition {
  id: string;
  /** Executable and arguments, invoked directly without a shell. */
  argv: string[];
}

export interface ExecutionSelection {
  harness?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface TaskSubmission {
  repoPath: string;
  baseRef: string;
  prompt: string;
  acceptanceCriteria?: string[];
  /** Maximum content revisions after the first implementation attempt. */
  maxRevisions?: number;
  allowedPaths?: string[];
  checks?: CheckDefinition[];
  /** Any omitted field is selected by the Codex coordinator. */
  selection?: ExecutionSelection;
  /** Ordered execution stages in one task worktree. Omitted fields are completed by the Codex coordinator. */
  executionStages?: ExecutionSelection[];
}

export type SelectionSource = "task" | "project" | "global" | "codex";

export interface RouteDecision {
  taskId: string;
  harness: string;
  model: string;
  reasoningEffort?: string;
  /** Effective value after user selection and Codex completion. */
  effectiveReasoningEffort?: string;
  selectionSource: SelectionSource;
  /** Per-field source is retained because a task may specify only some fields. */
  fieldSources?: {
    harness: SelectionSource;
    model: SelectionSource;
    reasoningEffort: SelectionSource;
  };
  bindingId?: string;
  configHash?: string;
  reason: string;
  candidates?: unknown[];
  artifacts?: { stdoutPath?: string; stderrPath?: string; eventsPath?: string };
  decidedAt: string;
}

export interface TaskRecord extends TaskSubmission {
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  revisionCount: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  failureReason?: string;
  /** Why automatic execution stopped after an expired lease. */
  recoveryReason?: string;
  /** Snapshot of the expired lease and interrupted work, retained for inspection. */
  recoveryEvidence?: Record<string, unknown>;
  route?: RouteDecision;
  activeAttemptId?: string;
  retryAt?: string;
  resumeStage?: "route" | "implementation" | "review";
  resumeCheckpoint?: Record<string, unknown>;
  quotaRetryCount?: number;
}

export type AttemptRole = "implement" | "revise" | "review" | "route";
export type AttemptStatus = "running" | "succeeded" | "failed" | "interrupted";

export interface Attempt {
  id: string;
  taskId: string;
  /** Optional logical-stage link; absent on pre-stage attempts. */
  stageId?: string;
  sequence: number;
  role: AttemptRole;
  status: AttemptStatus;
  harness?: string;
  model?: string;
  reasoningEffort?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  stdoutPath?: string;
  stderrPath?: string;
  resultPath?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type StageRole = "implement" | "revise" | "review" | "route";
export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "interrupted";

export interface StageRecord {
  id: string;
  taskId: string;
  sequence: number;
  role: StageRole;
  status: StageStatus;
  predecessorStageId?: string;
  harness?: string;
  harnessVersion?: string;
  model?: string;
  reasoningEffort?: string;
  bindingVersion?: string;
  configHash?: string;
  processStartId: string;
  inputFingerprint?: string;
  outputFingerprint?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface HandoffV1 {
  schemaVersion: 1;
  taskId: string;
  stageId: string;
  createdAt: string;
  source: { attemptId: string; harness: string; model: string; harnessVersion?: string; bindingVersion?: string; configHash?: string; processStartId?: string };
  task: { objective: string; latestUserInstruction?: string; acceptanceCriteria: string[] };
  workspace: {
    baseCommit?: string;
    headCommit?: string;
    fingerprint?: string;
    state: "clean" | "dirty" | "unknown";
    changedFiles?: string[];
  };
  completed: string[];
  currentState: string;
  decisions: Array<{ decision: string; rationale: string }>;
  rejectedOptions: Array<{ option: string; reason: string }>;
  keyFiles: Array<{ path: string; reason: string }>;
  checks: Array<{ id: string; status: "passed" | "failed" | "timed_out" | "not_run"; evidence?: string }>;
  blockers: string[];
  risks: string[];
  nextSteps: string[];
}

export interface HandoffRecord extends HandoffV1 {
  id: string;
  byteLength: number;
}

export interface RunRequest {
  taskId: string;
  attemptId: string;
  role: AttemptRole;
  cwd: string;
  prompt: string;
  harness: string;
  model: string;
  reasoningEffort?: string;
  baseCommit?: string;
  allowedPaths?: string[];
  deadline?: string;
  artifactDir?: string;
  outputSchemaPath?: string;
  environment?: Record<string, string>;
  readOnly?: boolean;
}

export interface RunResult {
  status: "completed" | "failed" | "timed_out" | "cancelled";
  exitCode: number | null;
  final?: string;
  stdoutPath?: string;
  stderrPath?: string;
  eventsPath?: string;
  requestedModel?: string;
  actualModel?: string;
  harnessVersion?: string;
  durationMs: number;
  sessionId?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  quota?: { retryAt?: string; source: "provider_message" | "retry_after" | "fallback" };
}

export interface HarnessCapabilities {
  harness: string;
  version?: string;
  models: string[];
  reasoningEfforts?: string[];
  roles?: AttemptRole[];
  available: boolean;
  unavailableReason?: string;
  /** CLI capability probe does not contact providers or validate model authentication. */
  probeEvidence?: {
    versionAndHelp: "passed" | "failed";
    authentication: "not_checked";
    modelSmokeTest: "not_checked";
    configuredBindings: "declared_verified" | "none";
    bindingVerification?: Record<string, "smoke_test" | "manual_config">;
  };
}

export interface HarnessAdapter {
  readonly id: string;
  probe(): Promise<HarnessCapabilities>;
  run(request: RunRequest): Promise<RunResult>;
  cancel?(taskId: string, attemptId: string): Promise<void>;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  type: string;
  at: string;
  payload?: Record<string, unknown>;
}

export interface CheckResult {
  id: string;
  argv: string[];
  status: "passed" | "failed" | "timed_out" | "spawn_error";
  exitCode: number | null;
  durationMs: number;
  stdoutPath?: string;
  stderrPath?: string;
  logTruncated?: boolean;
  error?: string;
}

export type ReviewVerdict = "pass" | "changes_requested" | "blocked";

export interface ReviewFinding {
  file?: string;
  line?: number;
  severity: "critical" | "high" | "medium" | "low";
  evidence: string;
  requestedChange: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  rawPath?: string;
}
