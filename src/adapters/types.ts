import type { ChildProcess } from 'node:child_process';
import type { HarnessAdapter as DomainHarnessAdapter, HarnessCapabilities as DomainHarnessCapabilities, RunRequest as DomainRunRequest, RunResult as DomainRunResult } from '../domain/types.js';

export type HarnessId = 'codex' | 'dsh' | 'zcode';
export type RunRole = 'implement' | 'revise' | 'review' | 'allocate';
export type RunStatus = 'completed' | 'failed' | 'timed_out' | 'cancelled';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Model configuration names an actual model independently of any CLI. */
export interface ModelConfig {
  id: string;
  provider: string;
  modelId: string;
}

/** A binding is enabled only after the model selector/auth/model smoke test is verified. */
export type ModelBinding =
  | { harness: 'codex'; model: ModelConfig; selector: 'cli_argument'; verified: true; verificationSource?: 'smoke_test' | 'manual_config'; verifiedCliVersion?: string; reasoningEfforts?: ReasoningEffort[] }
  | { harness: 'dsh'; model: ModelConfig; selector: 'profile'; profile: string; verified: true; verificationSource?: 'smoke_test' | 'manual_config'; verifiedCliVersion?: string; reasoningEfforts?: ReasoningEffort[] }
  | {
      harness: 'zcode';
      model: ModelConfig;
      selector: 'isolated_config';
      /** Per-run config directory prepared by Zero and verified to select model.modelId. */
      configDir: string;
      /** Explicit execution permission mode verified for this CLI release. */
      mode: string;
      verified: true;
      verificationSource?: 'smoke_test' | 'manual_config';
      verifiedCliVersion?: string;
      reasoningEfforts?: ReasoningEffort[];
    }
  | {
      harness: 'zcode';
      model: ModelConfig;
      selector: 'app_server_existing_desktop';
      /** Must be pinned to the CLI release whose app-server behavior was verified. */
      verified: true;
      verifiedCliVersion: string;
      verificationSource: 'smoke_test';
      /** Evidence is selector-only: app-server completion does not identify the actual model. */
      verificationEvidence: {
        kind: 'selector_only';
        verifiedAt: string;
        providerId: string;
        modelId: string;
        cliVersion: string;
      };
      /** Only reasoning levels independently checked against the exact model catalog entry. */
      reasoningEfforts?: ReasoningEffort[];
    };

export interface HarnessCapabilities {
  harness: HarnessId;
  available: boolean;
  executable: string;
  version?: string;
  reasons: string[];
  modelSelectors: Array<'cli_argument' | 'profile' | 'isolated_config'>;
  reasoningEfforts: ReasoningEffort[];
  outputFormats: string[];
  readOnlyReview: boolean;
}

export interface RunContext {
  taskId: string;
  attemptId: string;
  role: RunRole;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  artifactDir?: string;
  outputSchemaPath?: string;
  reasoningEffort?: ReasoningEffort;
  envAllowlist?: string[];
  /** Environment variable name -> secret reference. Values are resolved only for the child. */
  secretRefs?: Record<string, string>;
  /** Explicit refs are resolved by the host application and never persisted in reports. */
  resolveSecret?: (ref: string) => string | undefined;
}

export interface RunEvent {
  type: string;
  message?: string;
  data?: unknown;
}

export interface AdapterRunResult {
  harness: HarnessId;
  status: RunStatus;
  exitCode: number | null;
  requestedModel?: string;
  actualModel?: string;
  reasoningEffort?: ReasoningEffort;
  startedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  events: RunEvent[];
  finalText?: string;
  sessionId?: string;
  error?: string;
}

export interface Invocation {
  harness: HarnessId;
  executable: string;
  args: string[];
  /** Optional prompt/input streamed to child stdin instead of argv. */
  stdin?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  requestedModel?: string;
  reasoningEffort?: ReasoningEffort;
  parseOutput: (stdout: string, stderr: string) => ParsedOutput;
}

export interface ParsedOutput {
  events: RunEvent[];
  finalText?: string;
  actualModel?: string;
  sessionId?: string;
}

export interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  status: RunStatus;
  error?: string;
}

export interface ProcessRunnerOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  maxLogBytes?: number;
  secrets?: string[];
  signal?: AbortSignal;
  /** Injectable for deterministic tests. Production runner owns cancellation and process-tree termination. */
  spawnProcess?: (executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean; stdio: 'pipe' }) => ChildProcess;
}

export interface AdapterHarnessContract extends DomainHarnessAdapter {
  readonly id: HarnessId;
  probe(): Promise<DomainHarnessCapabilities>;
  prepare(context: RunContext, binding: ModelBinding): Promise<Invocation>;
  run(request: DomainRunRequest): Promise<DomainRunResult>;
}
