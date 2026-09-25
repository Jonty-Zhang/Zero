import type { HarnessAdapter, HarnessCapabilities, RunRequest, RunResult } from '../domain/types.js';
import type { ModelBinding } from './types.js';
import { ZCodeAdapter } from './zcode.js';
import { ZCodeAppServerAdapter } from './zcode-app-server-adapter.js';

type ZCodeBinding = Extract<ModelBinding, { harness: 'zcode' }>;

export interface ZCodeCompositeOptions {
  bindings: ModelBinding[];
  /** Injection points for tests; production keeps the two selectors separate. */
  isolated?: HarnessAdapter;
  existingDesktop?: HarnessAdapter;
}

/** Dispatches a Zero model ID to exactly one verified ZCode selection mechanism. */
export class ZCodeCompositeAdapter implements HarnessAdapter {
  readonly id = 'zcode' as const;
  private readonly bindings: ZCodeBinding[];
  private readonly isolated: HarnessAdapter;
  private readonly existingDesktop: HarnessAdapter;
  private readonly active = new Map<string, HarnessAdapter>();

  constructor(options: ZCodeCompositeOptions) {
    this.bindings = options.bindings.filter((binding): binding is ZCodeBinding => binding.harness === 'zcode');
    this.isolated = options.isolated ?? new ZCodeAdapter({ bindings: this.bindings.filter(binding => binding.selector === 'isolated_config') });
    this.existingDesktop = options.existingDesktop ?? new ZCodeAppServerAdapter({ bindings: this.bindings.filter(binding => binding.selector === 'app_server_existing_desktop') });
  }

  async probe(): Promise<HarnessCapabilities> {
    const [isolated, desktop] = await Promise.all([this.isolated.probe(), this.existingDesktop.probe()]);
    const models = this.bindings.flatMap(binding => {
      if (this.bindings.filter(candidate => candidate.model.id === binding.model.id).length !== 1) return [];
      const caps = binding.selector === 'isolated_config' ? isolated : desktop;
      return caps.available && caps.models.includes(binding.model.id) ? [binding.model.id] : [];
    });
    const versions = [...new Set([isolated.version, desktop.version].filter((version): version is string => !!version))];
    const available = isolated.available || desktop.available;
    return {
      harness: this.id,
      ...(versions.length === 1 ? { version: versions[0] } : {}),
      models: [...new Set(models)],
      reasoningEfforts: [...new Set(this.bindings.filter(binding => models.includes(binding.model.id)).flatMap(binding => binding.reasoningEfforts ?? []))],
      roles: ['implement', 'revise'],
      available,
      probeEvidence: {
        versionAndHelp: available ? 'passed' : 'failed',
        authentication: 'not_checked',
        modelSmokeTest: 'not_checked',
        configuredBindings: models.length ? 'declared_verified' : 'none',
      },
      ...(!available ? { unavailableReason: [isolated.unavailableReason, desktop.unavailableReason].filter(Boolean).join('; ') || 'ZCode adapters unavailable' } : {}),
    };
  }

  async run(request: RunRequest): Promise<RunResult> {
    if (request.harness !== this.id) throw new Error('ZCode request has the wrong Harness');
    // `modelId` may repeat across providers. Route by Zero's unique model ID only.
    const matches = this.bindings.filter(binding => binding.model.id === request.model);
    if (matches.length !== 1) throw new Error('ZCode request has no unique verified Zero model binding');
    const adapter = matches[0]!.selector === 'isolated_config' ? this.isolated : this.existingDesktop;
    const key = `${request.taskId}:${request.attemptId}`;
    if (this.active.has(key)) throw new Error('ZCode attempt is already running');
    this.active.set(key, adapter);
    try { return await adapter.run(request); }
    finally { this.active.delete(key); }
  }

  async cancel(taskId: string, attemptId: string): Promise<void> {
    await this.active.get(`${taskId}:${attemptId}`)?.cancel?.(taskId, attemptId);
  }
}
