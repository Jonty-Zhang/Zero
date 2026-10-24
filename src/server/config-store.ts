import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelBinding, ModelConfig, ReasoningEffort } from '../adapters/types.js';
import { resolveModelIdentity } from '../adapters/model-binding.js';
import type { ExecutionSelection } from '../domain/types.js';

export interface LocalZeroConfig {
  models: ModelConfig[];
  bindings: ModelBinding[];
  allocator: { kind?: 'codex' | 'api'; modelId: string | null; reasoningEffort: ReasoningEffort | null; api?: { baseUrl: string; model: string; keyEnv: string } };
  reviewer: { modelId: string | null; reasoningEffort: ReasoningEffort | null };
  /** Optional for compatibility with config files written before execution presets existed. */
  executionDefaults?: { global: ExecutionSelection | null; projects: Record<string, ExecutionSelection> };
  verifications: Record<string, { verifiedAt: string; cliVersion: string; requestedModel: string; exitCode: 0; level: 'selector_only' | 'event_confirmed'; actualModel?: string; profile?: string; configDir?: string; mode?: string; reasoningEfforts: ReasoningEffort[]; effortEvidence?: Record<string, { verifiedAt: string; cliVersion: string; exitCode: 0 }> }>;
  /** Environment variable name -> secret reference; never returned by HTTP APIs. */
  secretRefs?: Record<string, string>;
}

export interface ZCodeAppServerVerificationEvidence {
  verifiedAt: string;
  cliVersion: string;
  providerId: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

export interface ZCodeAppServerNonceProof {
  nonce: string;
  echoedNonce: string;
  /** The one-time app-server verification request completed and its session ended successfully. */
  sessionEndedSuccessfully: boolean;
  /** The app-server peer confirmed that it exited after the verification request. */
  peerExited: boolean;
  reasoningEffort: ReasoningEffort;
}

const EMPTY: LocalZeroConfig = {
  models: [{ id: 'gpt-6-sol', provider: 'openai', modelId: 'gpt-6-sol' }],
  bindings: [],
  allocator: { modelId: null, reasoningEffort: null },
  reviewer: { modelId: null, reasoningEffort: null },
  executionDefaults: { global: null, projects: {} },
  verifications: {},
};

// A local queue prevents synchronous SQLite contention between operations that
// need this same event loop to finish their asynchronous JSON replacement.
const configUpdates = new Map<string, Promise<void>>();
async function waitForConfigLock(lock: DatabaseSync, statement: 'BEGIN IMMEDIATE' | 'COMMIT'): Promise<void> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    try { lock.exec(statement); return; }
    catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (typeof code !== 'number' || (code & 255) !== 5) throw error;
      if (performance.now() >= deadline) throw new Error('Timed out waiting for Zero configuration update lock');
      await delay(25);
    }
  }
}
async function withConfigUpdate<T>(path: string, change: (canonicalPath: string) => Promise<T>): Promise<T> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const canonicalPath = await realpath(absolute).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await realpath(dirname(absolute)), basename(absolute));
  });
  const key = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  const previous = configUpdates.get(key) ?? Promise.resolve();
  const update = previous.then(async () => {
    const lock = new DatabaseSync(`${canonicalPath}.write-lock.sqlite`);
    let acquired = false;
    try {
      lock.exec('PRAGMA busy_timeout=0');
      await waitForConfigLock(lock, 'BEGIN IMMEDIATE'); acquired = true;
      const result = await change(canonicalPath);
      // COMMIT needs an EXCLUSIVE lock, which a concurrent reader can delay
      // after BEGIN IMMEDIATE succeeded. Retry only COMMIT, never the mutation.
      await waitForConfigLock(lock, 'COMMIT'); acquired = false;
      return result;
    } finally {
      if (acquired) { try { lock.exec('ROLLBACK'); } catch { /* Closing also releases the process lock. */ } }
      lock.close();
    }
  });
  const settled = update.then(() => {}, () => {});
  configUpdates.set(key, settled);
  try { return await update; }
  finally { if (configUpdates.get(key) === settled) configUpdates.delete(key); }
}

export class ConfigStore {
  constructor(readonly path: string) {}

  async read(): Promise<LocalZeroConfig> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<LocalZeroConfig>;
      return {
        models: Array.isArray(parsed.models) ? parsed.models : [],
        bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
        allocator: { ...(parsed.allocator?.kind === 'api' || parsed.allocator?.kind === 'codex' ? { kind: parsed.allocator.kind } : {}),
          modelId: parsed.allocator?.modelId ?? null, reasoningEffort: parsed.allocator?.reasoningEffort ?? null,
          ...(parsed.allocator?.api ? { api: parsed.allocator.api } : {}) },
        reviewer: { modelId: parsed.reviewer?.modelId ?? null, reasoningEffort: parsed.reviewer?.reasoningEffort ?? null },
        ...(parsed.executionDefaults && typeof parsed.executionDefaults === 'object' ? { executionDefaults: normalizeExecutionDefaults(parsed.executionDefaults) } : {}),
        verifications: parsed.verifications ?? {},
        ...(parsed.secretRefs ? { secretRefs: parsed.secretRefs } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
      throw error;
    }
  }

  async write(value: LocalZeroConfig): Promise<void> {
    return this.update(async (previous, path) => {
      const next: LocalZeroConfig = {
        ...previous,
        allocator: value.allocator,
        reviewer: value.reviewer,
        ...(value.executionDefaults !== undefined ? { executionDefaults: value.executionDefaults } : {}),
      };
      await this.persist(next, path);
    });
  }

  /** Adds a user-selected ZCode desktop tuple to Zero's model registry only. */
  async registerZCodeDesktopModel(model: ModelConfig): Promise<'registered' | 'already_registered'> {
    if (!isValidLocalModel(model)) throw new Error('ZCode desktop model requires a safe local ID and exact provider/model IDs');
    return this.update(async (config, path) => {
      const sameId = config.models.filter(item => item.id === model.id);
      if (sameId.length) {
        if (sameId.length === 1 && sameId[0]!.provider === model.provider && sameId[0]!.modelId === model.modelId) {
          return 'already_registered';
        }
        throw new Error(`Local model ID ${model.id} is already registered with a different tuple`);
      }
      if (config.models.some(item => item.provider === model.provider && item.modelId === model.modelId)) {
        throw new Error('This exact provider/model tuple is already registered under another local model ID');
      }

      // This command only adds a model selector. It does not create or change a
      // binding, verification record, allocator choice, or reviewer choice.
      config.models = [...config.models, { ...model }];
      await this.persist(config, path);
      return 'registered' as const;
    });
  }

  async markVerified(harness: 'codex', modelId: string, evidence: Omit<LocalZeroConfig['verifications'][string], 'reasoningEfforts'> & { reasoningEfforts?: ReasoningEffort[] }, expectedModel?: ModelConfig): Promise<void> {
    return this.update(async (config, path) => {
      const model = resolveModelIdentity(config.models, modelId, item => item);
      if (!model) throw new Error(`Unknown or ambiguous model ID: ${modelId}`);
      if (expectedModel && !sameModelTuple(model, expectedModel)) {
        throw new Error(`Local model ${modelId} changed during Codex verification; run verification again`);
      }
      const key = `${harness}:${model.id}`;
      const previousBinding = config.bindings.find(item => item.harness === harness && item.model.id === model.id);
      const previousProof = config.verifications[key];
      // Independent effort proofs accumulate only for the same exact model and
      // CLI in both fresh records; a changed identity starts a new proof set.
      const sameVerification = previousBinding?.verified && sameModelTuple(previousBinding.model, model)
        && isPinnedCliVersion(evidence.cliVersion) && previousBinding.verifiedCliVersion === evidence.cliVersion
        && previousProof?.cliVersion === evidence.cliVersion && previousProof.exitCode === 0
        && previousProof.requestedModel === model.modelId && evidence.requestedModel === model.modelId
        && (!previousProof.actualModel || previousProof.actualModel === model.modelId)
        && (!evidence.actualModel || evidence.actualModel === model.modelId);
      const retainedEfforts = sameVerification
        ? (previousBinding.reasoningEfforts ?? []).filter(effort => (previousProof.reasoningEfforts ?? []).includes(effort)) : [];
      const incomingEfforts = evidence.reasoningEfforts ?? [];
      const reasoningEfforts = [...new Set([...retainedEfforts, ...incomingEfforts])];
      const retainedProofs = sameVerification ? Object.fromEntries(Object.entries(previousProof.effortEvidence ?? {})
        .filter(([effort, proof]) => retainedEfforts.includes(effort as ReasoningEffort)
          && proof.cliVersion === evidence.cliVersion && proof.exitCode === 0 && isValidTimestamp(proof.verifiedAt))) : {};
      const { effortEvidence: providedProofs, ...verificationEvidence } = evidence;
      const incomingProofs = Object.fromEntries(Object.entries(providedProofs ?? {})
        .filter(([effort, proof]) => incomingEfforts.includes(effort as ReasoningEffort)
          && proof.cliVersion === evidence.cliVersion && proof.exitCode === 0 && isValidTimestamp(proof.verifiedAt)));
      const effortEvidence = { ...retainedProofs, ...incomingProofs };
      const binding: ModelBinding = { harness, model, selector: 'cli_argument', verified: true, verificationSource: 'smoke_test', verifiedCliVersion: evidence.cliVersion, reasoningEfforts };
      config.bindings = [...config.bindings.filter(item => !(item.harness === harness && item.model.id === model.id)), binding];
      config.verifications[key] = { ...verificationEvidence, reasoningEfforts, ...(Object.keys(effortEvidence).length ? { effortEvidence } : {}) };
      await this.persist(config, path);
    });
  }

  async markDshVerified(modelId: string, expectedModel: ModelConfig, profile: string, evidence: Omit<LocalZeroConfig['verifications'][string], 'reasoningEfforts' | 'profile'>): Promise<void> {
    if (!isSafeDshProfile(profile)) throw new Error('DSH profile must be a safe profile name');
    if (!evidence.cliVersion.trim() || evidence.cliVersion === 'unknown') throw new Error('DSH CLI version is required to pin a verified binding');
    return this.update(async (config, path) => {
      const matches = config.models.filter(item => item.id === modelId);
      if (matches.length !== 1) throw new Error(`Expected exactly one local model ID: ${modelId}`);
      const model = matches[0]!;
      if (model.provider !== expectedModel.provider || model.modelId !== expectedModel.modelId) {
        throw new Error(`Local model ${modelId} changed during DSH verification; run verification again`);
      }
      const key = `dsh:${model.id}`;
      const binding: ModelBinding = {
        harness: 'dsh', model, selector: 'profile', profile, verified: true,
        verificationSource: 'smoke_test', verifiedCliVersion: evidence.cliVersion, reasoningEfforts: [],
      };
      config.bindings = [...config.bindings.filter(item => !(item.harness === 'dsh' && item.model.id === model.id)), binding];
      config.verifications[key] = { ...evidence, profile, reasoningEfforts: [] };
      await this.persist(config, path);
    });
  }

  async markZCodeVerified(modelId: string, expectedModel: ModelConfig, configDir: string, mode: string, evidence: Omit<LocalZeroConfig['verifications'][string], 'reasoningEfforts' | 'configDir' | 'mode'>): Promise<void> {
    if (!isAbsoluteConfigDir(configDir)) throw new Error('ZCode config directory must be an absolute path');
    if (!isSupportedZCodeMode(mode)) throw new Error('ZCode mode must be build or yolo');
    if (!evidence.cliVersion.trim() || evidence.cliVersion === 'unknown') throw new Error('ZCode CLI version is required to pin a verified binding');
    return this.update(async (config, path) => {
      const matches = config.models.filter(item => item.id === modelId);
      if (matches.length !== 1) throw new Error(`Expected exactly one local model ID: ${modelId}`);
      const model = matches[0]!;
      if (model.provider !== expectedModel.provider || model.modelId !== expectedModel.modelId) {
        throw new Error(`Local model ${modelId} changed during ZCode verification; run verification again`);
      }
      const key = `zcode:${model.id}`;
      const binding: ModelBinding = {
        harness: 'zcode', model, selector: 'isolated_config', configDir, mode, verified: true,
        verificationSource: 'smoke_test', verifiedCliVersion: evidence.cliVersion, reasoningEfforts: [],
      };
      config.bindings = [...config.bindings.filter(item => !(item.harness === 'zcode' && item.model.id === model.id)), binding];
      config.verifications[key] = { ...evidence, configDir, mode, reasoningEfforts: [] };
      await this.persist(config, path);
    });
  }

  async markZCodeAppServerVerified(
    modelId: string,
    expectedModel: ModelConfig,
    evidence: ZCodeAppServerVerificationEvidence,
    proof: ZCodeAppServerNonceProof,
  ): Promise<void> {
    if (!isPinnedCliVersion(evidence.cliVersion)) throw new Error('ZCode CLI version is required to pin a verified app-server binding');
    if (!isValidTimestamp(evidence.verifiedAt)) throw new Error('ZCode app-server verification timestamp is invalid');
    if (expectedModel.id !== modelId || !expectedModel.provider.trim() || !expectedModel.modelId.trim()
      || evidence.providerId !== expectedModel.provider || evidence.modelId !== expectedModel.modelId) {
      throw new Error('ZCode app-server verification evidence must match the exact provider/model tuple');
    }
    if (!isReasoningEffort(evidence.reasoningEffort) || proof.reasoningEffort !== evidence.reasoningEffort) {
      throw new Error('ZCode app-server verification must prove one supported reasoning effort');
    }
    if (!proof.nonce.trim() || !proof.echoedNonce.trim() || proof.nonce !== proof.echoedNonce) {
      throw new Error('ZCode app-server nonce verification did not match');
    }
    if (proof.sessionEndedSuccessfully !== true || proof.peerExited !== true) {
      throw new Error('ZCode app-server verification session must end successfully and the peer must exit');
    }

    // All checks run before persistence. A rejected proof leaves the existing config bytes untouched.
    return this.update(async (config, path) => {
      const matches = config.models.filter(item => item.id === modelId);
      if (matches.length !== 1) throw new Error(`Expected exactly one local model ID: ${modelId}`);
      const model = matches[0]!;
      if (model.provider !== expectedModel.provider || model.modelId !== expectedModel.modelId) {
        throw new Error(`Local model ${modelId} changed during ZCode app-server verification; run verification again`);
      }
      const key = `zcode:${model.id}`;
      const binding: Extract<ModelBinding, { selector: 'app_server_existing_desktop' }> = {
        harness: 'zcode',
        model,
        selector: 'app_server_existing_desktop',
        verified: true,
        verificationSource: 'smoke_test',
        verifiedCliVersion: evidence.cliVersion,
        verificationEvidence: {
          kind: 'selector_only',
          verifiedAt: evidence.verifiedAt,
          providerId: evidence.providerId,
          modelId: evidence.modelId,
          cliVersion: evidence.cliVersion,
          reasoningEffort: evidence.reasoningEffort,
        },
        reasoningEfforts: [evidence.reasoningEffort],
      };
      config.bindings = [...config.bindings.filter(item => !(item.harness === 'zcode' && item.model.id === model.id)), binding];
      config.verifications[key] = {
        verifiedAt: evidence.verifiedAt,
        cliVersion: evidence.cliVersion,
        requestedModel: model.modelId,
        exitCode: 0,
        level: 'selector_only',
        reasoningEfforts: [evidence.reasoningEffort],
        effortEvidence: {
          [evidence.reasoningEffort]: { verifiedAt: evidence.verifiedAt, cliVersion: evidence.cliVersion, exitCode: 0 },
        },
      };
      await this.persist(config, path);
    });
  }

  async markReasoningEffortVerified(harness: 'codex', modelId: string, effort: ReasoningEffort, cliVersion: string): Promise<void> {
    return this.update(async (config, path) => {
      const model = resolveModelIdentity(config.models, modelId, item => item);
      const binding = config.bindings.find(item => item.harness === harness && item.model.id === model?.id && item.verified);
      const key = `${harness}:${model?.id}`;
      const verification = config.verifications[key];
      if (!model || !binding || !verification) throw new Error('Verify the base model binding before adding a reasoning effort');
      const efforts = [...new Set([...(binding.reasoningEfforts ?? []), effort])];
      const effortEvidence = { ...(verification.effortEvidence ?? {}), [effort]: { verifiedAt: new Date().toISOString(), cliVersion, exitCode: 0 as const } };
      config.bindings = config.bindings.map(item => item === binding ? { ...binding, reasoningEfforts: efforts } : item);
      config.verifications[key] = { ...verification, reasoningEfforts: efforts, effortEvidence };
      await this.persist(config, path);
    });
  }

  async invalidateVersionMismatches(versions: Partial<Record<'codex' | 'dsh' | 'zcode', string | undefined>>): Promise<string[]> {
    return this.update(async (config, path) => {
      const invalid = config.bindings.filter(binding => binding.verifiedCliVersion && versions[binding.harness] && binding.verifiedCliVersion !== versions[binding.harness]);
      if (!invalid.length) return [];
      const keys = new Set(invalid.map(binding => `${binding.harness}:${binding.model.id}`));
      config.bindings = config.bindings.filter(binding => !keys.has(`${binding.harness}:${binding.model.id}`));
      for (const key of keys) delete config.verifications[key];
      await this.persist(config, path);
      return [...keys];
    });
  }

  private update<T>(change: (config: LocalZeroConfig, canonicalPath: string) => Promise<T>): Promise<T> {
    return withConfigUpdate(this.path, async path => change(await this.read(), path));
  }

  private async persist(config: LocalZeroConfig, path: string): Promise<void> {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function normalizeExecutionDefaults(value: NonNullable<LocalZeroConfig['executionDefaults']>): NonNullable<LocalZeroConfig['executionDefaults']> {
  const input = value as unknown as Record<string, unknown>;
  const rawProjects = input.projects;
  const projects = rawProjects && typeof rawProjects === 'object' && !Array.isArray(rawProjects)
    ? rawProjects as Record<string, ExecutionSelection>
    : {};
  const rawGlobal = input.global;
  const global = rawGlobal && typeof rawGlobal === 'object' && !Array.isArray(rawGlobal) ? rawGlobal as ExecutionSelection : null;
  return { global, projects };
}

function isSafeDshProfile(profile: string): boolean {
  return profile.toLowerCase() !== 'desktop' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile);
}

function sameModelTuple(left: ModelConfig, right: ModelConfig): boolean {
  return left.id === right.id && left.provider === right.provider && left.modelId === right.modelId;
}

function isAbsoluteConfigDir(path: string): boolean {
  return isAbsolute(path);
}

function isSupportedZCodeMode(mode: string): boolean { return mode === 'build' || mode === 'yolo'; }

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value);
}

function isPinnedCliVersion(version: string): boolean {
  return version.trim().length > 0 && version === version.trim() && !/^unknown$/i.test(version) && !/[\r\n\0]/.test(version);
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isValidLocalModel(model: ModelConfig): boolean {
  const safe = (value: string) => typeof value === 'string' && value.length > 0 && value === value.trim() &&
    value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
  return Boolean(model && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model.id) && safe(model.provider) && safe(model.modelId));
}
