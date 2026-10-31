import { HttpError } from './http-error';

export interface VerificationJob {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  modelId: string;
  requestedModelIds?: string[];
  reasoningEffort: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}
export interface ConnectionSetup { codex: { available: boolean; reason?: string; models: Array<{ id: string; label: string }>; reasoningEfforts: string[] } }
type Draft = { modelId: string; reasoningEffort: string };
type Pending = Readonly<Draft & { key: string; jobId?: string }>;
interface Snapshot { draft: Draft; job: VerificationJob | null; pending: Pending | null; busy: boolean; uncertain: boolean; error: string }
interface Transport {
  start(modelId: string, effort: string, key: string): Promise<VerificationJob>;
  read(id: string): Promise<VerificationJob>;
}
const active = (job: VerificationJob) => job.state === 'queued' || job.state === 'running';
const storageKey = 'zero.connection-verification';

/** One per App. Dialog teardown never owns a model request or its retry key. */
export function createConnectionVerification(transport: Transport, storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  let restored: Pending | null = null;
  try {
    const value = JSON.parse(storage?.getItem(storageKey) ?? 'null');
    if (value && typeof value.modelId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.modelId)
        && ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value.reasoningEffort)
        && /^[A-Za-z0-9_-]{16,128}$/.test(value.key) && (value.jobId === undefined || typeof value.jobId === 'string')) restored = value;
  } catch { /* Storage is optional; never read authentication or task content. */ }
  const draftInitialized = { modelId: !!restored, reasoningEffort: !!restored };
  let snapshot: Snapshot = { draft: { modelId: restored?.modelId ?? '', reasoningEffort: restored?.reasoningEffort ?? 'high' }, job: null, pending: restored, busy: false, uncertain: !!restored && !restored.jobId, error: '' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    if (disposed) return;
    snapshot = next;
    try { if (next.pending) storage?.setItem(storageKey, JSON.stringify(next.pending)); else storage?.removeItem(storageKey); } catch { /* In-memory ownership still works. */ }
    for (const listener of [...listeners]) listener();
  };
  const accept = (job: VerificationJob, pending: Pending) => {
    if (!job || typeof job.id !== 'string' || !job.id
        || (job.modelId !== pending.modelId && !(Array.isArray(job.requestedModelIds) && job.requestedModelIds.includes(pending.modelId)))
        || job.reasoningEffort !== pending.reasoningEffort
        || !['queued', 'running', 'succeeded', 'failed', 'interrupted'].includes(job.state)
        || (pending.jobId && job.id !== pending.jobId)) throw new Error('验证结果与原连接请求不匹配，请重试读取原结果');
    publish({ ...snapshot, job, pending: active(job) ? { ...pending, jobId: job.id } : null, busy: false, uncertain: false, error: '' });
    if (!disposed && active(job)) timer = setTimeout(() => { void read(); }, 1000);
  };
  const read = async () => {
    const pending = snapshot.pending;
    if (disposed || snapshot.busy || !pending?.jobId) return;
    clearTimeout(timer);
    timer = undefined;
    publish({ ...snapshot, busy: true, error: '' });
    try { accept(await transport.read(pending.jobId), pending); }
    catch (e) { publish({ ...snapshot, busy: false, error: e instanceof Error ? e.message : '无法读取验证结果' }); }
  };
  const submit = async (pending: Pending) => {
    publish({ ...snapshot, job: null, pending, busy: true, uncertain: false, error: '' });
    try { accept(await transport.start(pending.modelId, pending.reasoningEffort, pending.key), pending); }
    catch (e) {
      const rejected = e instanceof HttpError && [400, 409].includes(e.status) && e.verificationNotStarted;
      publish({ ...snapshot, pending: rejected ? null : snapshot.pending, busy: false, uncertain: !rejected, error: e instanceof Error ? e.message : '连接请求未确认' });
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    initializeDraft(setup: ConnectionSetup) {
      if (disposed || snapshot.pending || snapshot.busy || (draftInitialized.modelId && draftInitialized.reasoningEffort)) return;
      const draft = {
        modelId: draftInitialized.modelId ? snapshot.draft.modelId : setup.codex.models[0]?.id ?? '',
        reasoningEffort: draftInitialized.reasoningEffort ? snapshot.draft.reasoningEffort : setup.codex.reasoningEfforts.includes('high') ? 'high' : setup.codex.reasoningEfforts[0] ?? 'high',
      };
      draftInitialized.modelId = draftInitialized.reasoningEffort = true;
      publish({ ...snapshot, draft });
    },
    editDraft(change: Partial<Draft>) {
      if (disposed || snapshot.pending || snapshot.busy) return;
      if (change.modelId !== undefined) draftInitialized.modelId = true;
      if (change.reasoningEffort !== undefined) draftInitialized.reasoningEffort = true;
      publish({ ...snapshot, draft: { ...snapshot.draft, ...change } });
    },
    async start(modelId: string, reasoningEffort: string) {
      if (disposed || snapshot.busy || snapshot.pending) return;
      await submit({ modelId: modelId.trim(), reasoningEffort, key: crypto.randomUUID() });
    },
    async retry() {
      if (disposed || snapshot.busy || !snapshot.pending) return;
      if (snapshot.pending.jobId) await read();
      else await submit(snapshot.pending);
    },
    resume() { if (snapshot.pending?.jobId && !timer) void read(); },
    dispose() { disposed = true; clearTimeout(timer); listeners.clear(); },
  };
}
export type ConnectionVerification = ReturnType<typeof createConnectionVerification>;
