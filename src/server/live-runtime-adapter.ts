import type { ModelBinding } from '../adapters/types.js';
import type { HarnessAdapter, HarnessCapabilities, RunRequest, RunResult } from '../domain/types.js';
import type { LocalZeroConfig } from './config-store.js';
import { guardRuntimeBindings, RUNTIME_BINDING_RESTART_REQUIRED } from './runtime-binding-guard.js';

export interface LiveRuntimeAdapterOptions {
  id: string;
  startupBindings: readonly ModelBinding[];
  readConfig: () => Promise<LocalZeroConfig>;
  createDelegate: (bindings: ModelBinding[]) => HarnessAdapter;
}

/** Stable attempt ownership; configuration edits alone never grant new selectors. */
export class LiveRuntimeAdapter implements HarnessAdapter {
  readonly id: string;
  private approved: ModelBinding[];
  private readonly authorizations = new Map<string, (current: LocalZeroConfig) => boolean>();
  private readonly active = new Map<string, HarnessAdapter>();
  constructor(private readonly options: LiveRuntimeAdapterOptions) {
    this.id = options.id;
    this.approved = structuredClone(options.startupBindings.filter(binding => binding.harness === this.id));
  }
  private delegate(bindings = this.approved, readConfig = this.options.readConfig, authorizations = this.authorizations): HarnessAdapter {
    const snapshot = structuredClone(bindings);
    const capturedAuthorizations = new Map(authorizations);
    const adapter = this.options.createDelegate(snapshot);
    if (adapter.id !== this.id) throw new Error('Live adapter delegate identity mismatch');
    return guardRuntimeBindings(adapter, snapshot, async () => {
      const current = await readConfig();
      const revoked = new Set(snapshot.filter(binding => {
        const authorize = capturedAuthorizations.get(binding.model.id);
        return authorize && !authorize(current);
      }).map(binding => binding.model.id));
      // Startup bindings retain their existing compatibility rules. Only newly
      // activated receipts add this stricter authorization boundary.
      return revoked.size ? { ...current, bindings: current.bindings.filter(binding => binding.harness !== this.id || !revoked.has(binding.model.id)) } : current;
    });
  }
  private assertIdentity(binding: ModelBinding): void {
    const previous = this.approved.filter(item => item.model.id === binding.model.id);
    const identity = (item: ModelBinding) => JSON.stringify({ harness: item.harness, selector: item.selector,
      localId: item.model.id, provider: item.model.provider, upstream: item.model.modelId });
    if (this.id !== 'codex' || binding.harness !== this.id || binding.selector !== 'cli_argument'
        || previous.length > 1 || previous.some(item => identity(item) !== identity(binding))) {
      throw new Error(RUNTIME_BINDING_RESTART_REQUIRED);
    }
  }
  /** Only the successful explicit verification path may call this method. */
  async activate(binding: ModelBinding, configSnapshot: LocalZeroConfig, authorize?: (current: LocalZeroConfig) => boolean): Promise<void> {
    const candidate = structuredClone(binding);
    this.assertIdentity(candidate);
    const submitted = structuredClone(configSnapshot);
    const candidateAuthorizations = new Map(this.authorizations);
    if (authorize) candidateAuthorizations.set(candidate.model.id, authorize);
    const selectedReport = await this.delegate([candidate], async () => submitted, candidateAuthorizations).probe();
    if (!selectedReport.available || !selectedReport.models.includes(candidate.model.id)) {
      throw new Error('Runtime activation requires the exact verified configuration snapshot');
    }
    const currentReport = await this.delegate([candidate], this.options.readConfig, candidateAuthorizations).probe();
    if (!currentReport.available || !currentReport.models.includes(candidate.model.id)) {
      throw new Error('Model binding changed before runtime activation');
    }
    // A successful generic probe cannot authorize a different verification
    // receipt. Commit only after its complete proof passes on the final read.
    if (authorize && !authorize(await this.options.readConfig())) {
      throw new Error('Model binding or proof changed during runtime activation');
    }
    // Another activation may have completed while the real probe was pending.
    this.assertIdentity(candidate);
    if (authorize) this.authorizations.set(candidate.model.id, authorize);
    this.approved = [...this.approved.filter(item => item.model.id !== candidate.model.id), candidate];
  }
  async probe(): Promise<HarnessCapabilities> { return this.delegate().probe(); }
  async run(request: RunRequest): Promise<RunResult> {
    const key = JSON.stringify([request.taskId, request.attemptId]);
    if (this.active.has(key)) return { status: 'failed', exitCode: null, durationMs: 0, error: 'Harness attempt is already running' };
    const delegate = this.delegate();
    this.active.set(key, delegate);
    try { return await delegate.run(request); }
    finally { if (this.active.get(key) === delegate) this.active.delete(key); }
  }
  async cancel(taskId: string, attemptId: string): Promise<void> {
    await this.active.get(JSON.stringify([taskId, attemptId]))?.cancel?.(taskId, attemptId);
  }
}
