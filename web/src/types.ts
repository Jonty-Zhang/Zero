export type Status = 'pending' | 'running' | 'reviewing' | 'revision' | 'waiting' | 'recovery_required' | 'done' | 'failed';
export type Choice = { id: string; label: string };
export type HarnessHealth = { id: string; name: string; available: boolean; reason?: string | null };
export type Binding = {
  harnessId: string;
  modelId: string;
  modelName?: string;
  available: boolean;
  reason?: string | null;
  reasoningEfforts?: Choice[];
};
export type Capabilities = {
  harnesses: HarnessHealth[];
  bindings: Binding[];
  allocator: { models: Choice[]; reasoningEfforts: Choice[] };
  reviewer: { models: Choice[]; reasoningEfforts: Choice[] };
};
export type RouteInfo = {
  harnessId?: string;
  modelId?: string;
  reasoningEffort?: string;
  selectionSource?: string;
  reason?: string;
};
export type Attempt = {
  number?: number;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  sessionId?: string;
  route?: RouteInfo;
  summary?: string;
  tests?: TestResult[];
  review?: ReviewResult;
  logs?: string | string[];
};
export type TestResult = { name?: string; command?: string; status?: string; exitCode?: number | null; durationMs?: number; output?: string };
export type ReviewResult = { verdict?: string; summary?: string; findings?: Array<{ severity?: string; file?: string; line?: number; message?: string }>; modelId?: string };
export type Task = {
  id: string;
  title?: string;
  prompt?: string;
  acceptanceCriteria?: string;
  repoPath?: string;
  baseRef?: string;
  status: Status;
  createdAt?: string;
  updatedAt?: string;
  retryAt?: string;
  recoveryReason?: string;
  recoveryEvidence?: Record<string, unknown>;
  route?: RouteInfo;
  attempts?: Attempt[];
  tests?: TestResult[];
  review?: ReviewResult;
  logs?: string | string[];
  report?: string;
  error?: string;
  maxRevisions?: number;
};
export type TaskSequenceStatus = 'queued' | 'running' | 'waiting' | 'blocked' | 'steps_completed' | 'completed';
export type SequenceGoalReview = {
  state: 'running' | 'quota' | 'verdict';
  result?: ReviewResult;
  retryAt?: string;
  createdAt: string;
  completedAt?: string;
};
export type TaskSequence = {
  id: string;
  status: TaskSequenceStatus;
  objective?: string;
  acceptanceCriteria?: string[];
  goalReview?: SequenceGoalReview;
  createdAt: string;
  updatedAt: string;
  steps: Array<{ position: number; task: Task; effectiveBaseCommit?: string }>;
  blockedReason?: { taskId: string; status: Status; reason?: string };
};
export type Config = {
  allocator: {
    kind: 'codex' | 'api';
    modelId: string | null;
    reasoningEffort: string | null;
    api?: { baseUrl: string | null; model: string | null; keyEnv: string | null };
  };
  reviewer: { modelId: string | null; reasoningEffort: string | null };
};
