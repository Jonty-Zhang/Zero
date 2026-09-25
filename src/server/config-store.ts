import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelBinding, ModelConfig, ReasoningEffort } from '../adapters/types.js';

export interface LocalZeroConfig {
  models: ModelConfig[];
  bindings: ModelBinding[];
  allocator: { modelId: string | null; reasoningEffort: ReasoningEffort | null };
  reviewer: { modelId: string | null; reasoningEffort: ReasoningEffort | null };
  verifications: Record<string, { verifiedAt: string; cliVersion: string; requestedModel: string; exitCode: 0; level: 'selector_only' | 'event_confirmed'; actualModel?: string; profile?: string; configDir?: string; mode?: string; reasoningEfforts: ReasoningEffort[]; effortEvidence?: Record<string, { verifiedAt: string; cliVersion: string; exitCode: 0 }> }>;
  /** Environment variable name -> secret reference; never returned by HTTP APIs. */
  secretRefs?: Record<string, string>;
}

export interface ZCodeAppServerVerificationEvidence {
  verifiedAt: string;
  cliVersion: string;
  providerId: string;
  modelId: string;
}

export interface ZCodeAppServerNonceProof {
  nonce: string;
  echoedNonce: string;
  /** The one-time app-server verification request completed and its session ended successfully. */
  sessionEndedSuccessfully: boolean;
  /** The app-server peer confirmed that it exited after the verification request. */
  peerExited: boolean;
}

const EMPTY: LocalZeroConfig = {
  models: [{ id: 'gpt-6-sol', provider: 'openai', modelId: 'gpt-6-sol' }],
  bindings: [],
  allocator: { modelId: null, reasoningEffort: null },
  reviewer: { modelId: null, reasoningEffort: null },
  verifications: {},
};

export class ConfigStore {
  constructor(readonly path: string) {}

  async read(): Promise<LocalZeroConfig> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<LocalZeroConfig>;
      return {
        models: Array.isArray(parsed.models) ? parsed.models : [],
        bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
        allocator: { modelId: parsed.allocator?.modelId ?? null, reasoningEffort: parsed.allocator?.reasoningEffort ?? null },
        reviewer: { modelId: parsed.reviewer?.modelId ?? null, reasoningEffort: parsed.reviewer?.reasoningEffort ?? null },
        verifications: parsed.verifications ?? {},
        ...(parsed.secretRefs ? { secretRefs: parsed.secretRefs } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
      throw error;
    }
  }

  async write(value: LocalZeroConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const previous = await this.read();
    const next: LocalZeroConfig = {
      ...previous,
      allocator: value.allocator,
      reviewer: value.reviewer,
    };
    await this.persist(next);
  }

  async markVerified(harness: 'codex', modelId: string, evidence: Omit<LocalZeroConfig['verifications'][string], 'reasoningEfforts'> & { reasoningEfforts?: ReasoningEffort[] }): Promise<void> {
    const config = await this.read();
    const model = config.models.find(item => item.id === modelId || item.modelId === modelId);
    if (!model) throw new Error(`Unknown model ID: ${modelId}`);
    const key = `${harness}:${model.id}`;
    const reasoningEfforts = evidence.reasoningEfforts ?? config.bindings.find(item => item.harness === harness && item.model.id === model.id)?.reasoningEfforts ?? [];
    const binding: ModelBinding = { harness, model, selector: 'cli_argument', verified: true, verificationSource: 'smoke_test', verifiedCliVersion: evidence.cliVersion, reasoningEfforts };
    config.bindings = [...config.bindings.filter(item => !(item.harness === harness && item.model.id === model.id)), binding];
    config.verifications[key] = { ...evidence, reasoningEfforts };
    await this.persist(config);
  }

  async markDshVerified(modelId: string, expectedModel: ModelConfig, profile: string, evidence: Omit<LocalZeroConfig['verifications'][string], 'reasoningEfforts' | 'profile'>): Promise<void> {
    if (!isSafeDshProfile(profile)) throw new Error('DSH profile must be a safe profile name');
    if (!evidence.cliVersion.trim() || evidence.cliVersion === 'unknown') throw new Error('DSH CLI version is required to pin a verified binding');
    const config = await this.read();
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
    await this.persist(config);
  }

  async markZCodeVerified(modelId: string, expectedModel: ModelConfig, configDir: string, mode: string, evidence: Omit<LocalZeroConfig['verifications'][string], 'reasoningEfforts' | 'configDir' | 'mode'>): Promise<void> {
    if (!isAbsoluteConfigDir(configDir)) throw new Error('ZCode config directory must be an absolute path');
    if (!isSupportedZCodeMode(mode)) throw new Error('ZCode mode must be build or yolo');
    if (!evidence.cliVersion.trim() || evidence.cliVersion === 'unknown') throw new Error('ZCode CLI version is required to pin a verified binding');
    const config = await this.read();
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
    await this.persist(config);
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
    if (!proof.nonce.trim() || !proof.echoedNonce.trim() || proof.nonce !== proof.echoedNonce) {
      throw new Error('ZCode app-server nonce verification did not match');
    }
    if (proof.sessionEndedSuccessfully !== true || proof.peerExited !== true) {
      throw new Error('ZCode app-server verification session must end successfully and the peer must exit');
    }

    // All checks run before persistence. A rejected proof leaves the existing config bytes untouched.
    const config = await this.read();
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
      },
      reasoningEfforts: [],
    };
    config.bindings = [...config.bindings.filter(item => !(item.harness === 'zcode' && item.model.id === model.id)), binding];
    config.verifications[key] = {
      verifiedAt: evidence.verifiedAt,
      cliVersion: evidence.cliVersion,
      requestedModel: model.modelId,
      exitCode: 0,
      level: 'selector_only',
      reasoningEfforts: [],
    };
    await this.persist(config);
  }

  async markReasoningEffortVerified(harness: 'codex', modelId: string, effort: ReasoningEffort, cliVersion: string): Promise<void> {
    const config = await this.read();
    const model = config.models.find(item => item.id === modelId || item.modelId === modelId);
    const binding = config.bindings.find(item => item.harness === harness && item.model.id === model?.id && item.verified);
    const key = `${harness}:${model?.id}`;
    const verification = config.verifications[key];
    if (!model || !binding || !verification) throw new Error('Verify the base model binding before adding a reasoning effort');
    const efforts = [...new Set([...(binding.reasoningEfforts ?? []), effort])];
    const effortEvidence = { ...(verification.effortEvidence ?? {}), [effort]: { verifiedAt: new Date().toISOString(), cliVersion, exitCode: 0 as const } };
    config.bindings = config.bindings.map(item => item === binding ? { ...binding, reasoningEfforts: efforts } : item);
    config.verifications[key] = { ...verification, reasoningEfforts: efforts, effortEvidence };
    await this.persist(config);
  }

  async invalidateVersionMismatches(versions: Partial<Record<'codex' | 'dsh' | 'zcode', string | undefined>>): Promise<string[]> {
    const config = await this.read();
    const invalid = config.bindings.filter(binding => binding.verifiedCliVersion && versions[binding.harness] && binding.verifiedCliVersion !== versions[binding.harness]);
    if (!invalid.length) return [];
    const keys = new Set(invalid.map(binding => `${binding.harness}:${binding.model.id}`));
    config.bindings = config.bindings.filter(binding => !keys.has(`${binding.harness}:${binding.model.id}`));
    for (const key of keys) delete config.verifications[key];
    await this.persist(config);
    return [...keys];
  }

  private async persist(config: LocalZeroConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function isSafeDshProfile(profile: string): boolean {
  return profile.toLowerCase() !== 'desktop' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile);
}

function isAbsoluteConfigDir(path: string): boolean {
  return isAbsolute(path);
}

function isSupportedZCodeMode(mode: string): boolean { return mode === 'build' || mode === 'yolo'; }

function isPinnedCliVersion(version: string): boolean {
  return version.trim().length > 0 && version === version.trim() && !/^unknown$/i.test(version) && !/[\r\n\0]/.test(version);
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
