import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelBinding, ModelConfig, ReasoningEffort } from '../adapters/types.js';

export interface LocalZeroConfig {
  models: ModelConfig[];
  bindings: ModelBinding[];
  allocator: { modelId: string | null; reasoningEffort: ReasoningEffort | null };
  reviewer: { modelId: string | null; reasoningEffort: ReasoningEffort | null };
  verifications: Record<string, { verifiedAt: string; cliVersion: string; requestedModel: string; exitCode: 0; level: 'selector_only' | 'event_confirmed'; actualModel?: string; reasoningEfforts: ReasoningEffort[]; effortEvidence?: Record<string, { verifiedAt: string; cliVersion: string; exitCode: 0 }> }>;
  /** Environment variable name -> secret reference; never returned by HTTP APIs. */
  secretRefs?: Record<string, string>;
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
