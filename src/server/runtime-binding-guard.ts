import type { HarnessAdapter, RunRequest, RunResult } from '../domain/types.js';
import type { ModelBinding } from '../adapters/types.js';
import { resolveModelBinding } from '../adapters/model-binding.js';
import type { LocalZeroConfig } from './config-store.js';
import { createHash } from 'node:crypto';
import type { HarnessCapabilities } from '../domain/types.js';

export const RUNTIME_BINDING_RESTART_REQUIRED = '模型绑定状态与运行时不一致，请确认验证状态并重启 Zero 后再使用';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function fingerprint(binding: ModelBinding): string {
  return createHash('sha256').update(JSON.stringify(canonical({ ...binding, reasoningEfforts: [...(binding.reasoningEfforts ?? [])].sort() }))).digest('hex');
}

/** The caller's config snapshot must describe the same binding as its probe. */
export function matchesRuntimeBinding(binding: ModelBinding, report: HarnessCapabilities | undefined): boolean {
  return !report?.runtimeBindingFingerprints || report.runtimeBindingFingerprints[binding.model.id] === fingerprint(binding);
}

/** Keep a running adapter on its captured selectors; changed bindings require restart. */
export function guardRuntimeBindings(adapter: HarnessAdapter, bindings: readonly ModelBinding[], readConfig: () => Promise<LocalZeroConfig>): HarnessAdapter {
  const startup = structuredClone(bindings.filter(binding => binding.harness === adapter.id));
  const fingerprints = new Map(startup.map(binding => [binding, fingerprint(binding)]));
  const active = new Map<string, { cancelled: boolean; started: boolean }>();
  function current(binding: ModelBinding, config: LocalZeroConfig): boolean {
    const models = config.models.filter(model => model.id === binding.model.id);
    const matches = config.bindings.filter(item => item.harness === adapter.id && item.model.id === binding.model.id);
    const proof = config.verifications[`${adapter.id}:${binding.model.id}`];
    return startup.filter(item => item.model.id === binding.model.id).length === 1
      && models.length === 1 && models[0]!.provider === binding.model.provider && models[0]!.modelId === binding.model.modelId
      && matches.length === 1 && matches[0]!.verified && fingerprint(matches[0]!) === fingerprints.get(binding)
      && !!proof && proof.exitCode === 0 && proof.requestedModel === binding.model.modelId
      && (!binding.verifiedCliVersion || proof.cliVersion === binding.verifiedCliVersion)
      && (!proof.actualModel || proof.actualModel === binding.model.modelId)
      && (binding.reasoningEfforts ?? []).every(effort => proof.reasoningEfforts?.includes(effort));
  }
  const key = (taskId: string, attemptId: string) => JSON.stringify([taskId, attemptId]);
  return {
    id: adapter.id,
    async probe() {
      const report = await adapter.probe();
      const config = await readConfig();
      const allowed = startup.filter(binding => current(binding, config)).map(binding => binding.model.id);
      const models = report.models.filter(model => allowed.includes(model));
      const modelUnavailableReasons = { ...report.modelUnavailableReasons };
      for (const binding of config.bindings.filter(binding => binding.harness === adapter.id)) {
        if (!allowed.includes(binding.model.id)) modelUnavailableReasons[binding.model.id] = RUNTIME_BINDING_RESTART_REQUIRED;
      }
      return { ...report, models, modelUnavailableReasons, runtimeBindingFingerprints: Object.fromEntries(startup.filter(binding => models.includes(binding.model.id)).map(binding => [binding.model.id, fingerprints.get(binding)!])),
        ...(report.probeEvidence ? { probeEvidence: { ...report.probeEvidence, configuredBindings: models.length ? 'declared_verified' as const : 'none' as const,
          ...(report.probeEvidence.bindingVerification ? { bindingVerification: Object.fromEntries(Object.entries(report.probeEvidence.bindingVerification).filter(([model]) => models.includes(model))) } : {}) } } : {}) };
    },
    async run(request: RunRequest): Promise<RunResult> {
      const startedAt = Date.now();
      const result = (status: RunResult['status'], error: string): RunResult => ({ status, exitCode: null, durationMs: Date.now() - startedAt, requestedModel: request.model, error });
      const attempt = key(request.taskId, request.attemptId);
      if (active.has(attempt)) return result('failed', 'Harness attempt is already running');
      const state = { cancelled: false, started: false };
      active.set(attempt, state);
      try {
        let config: LocalZeroConfig;
        try { config = await readConfig(); }
        catch { return state.cancelled ? result('cancelled', 'Task was cancelled') : result('failed', '无法读取模型绑定状态，请检查 Zero 配置后重试'); }
        if (state.cancelled) return result('cancelled', 'Task was cancelled');
        const binding = resolveModelBinding(startup, request.model);
        if (request.harness !== adapter.id || !binding || !current(binding, config)) return result('failed', RUNTIME_BINDING_RESTART_REQUIRED);
        state.started = true;
        return await adapter.run(request);
      } finally { active.delete(attempt); }
    },
    async cancel(taskId: string, attemptId: string) {
      const state = active.get(key(taskId, attemptId));
      if (!state) return;
      state.cancelled = true;
      if (state.started) await adapter.cancel?.(taskId, attemptId);
    },
  };
}
