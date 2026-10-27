import { useCallback, useSyncExternalStore } from 'react';

export interface BossMessageDraft {
  readonly content: string;
  readonly revision: number;
  readonly busy: boolean;
  readonly error: string;
  /** The visible, unchanged draft was confirmed delivered. */
  readonly sent: boolean;
}

export interface BossMessageComposer {
  getSnapshot(taskId: string): BossMessageDraft;
  subscribe(listener: () => void): () => void;
  setContent(taskId: string, content: string): void;
  /** False for denied, duplicate or failed sends; only one actual delivery returns true. */
  send(taskId: string, options?: { allowed?: boolean }): Promise<boolean>;
}

export interface BossMessageComposerOptions {
  send: (taskId: string, content: string) => Promise<unknown>;
  onSent?: (taskId: string) => void | Promise<void>;
}

interface PendingMessage { operationId: number; content: string; revision: number }
interface Entry { snapshot: BossMessageDraft; pending?: PendingMessage }

const EMPTY: BossMessageDraft = Object.freeze({ content: '', revision: 0, busy: false, error: '', sent: false });

/**
 * Create once per App instance. Drawer unmounts detach React subscribers only;
 * drafts and in-flight request custody remain here until the request settles.
 * Message text is intentionally never persisted in browser storage.
 */
export function createBossMessageComposer(options: BossMessageComposerOptions): BossMessageComposer {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let sequence = 0;

  const read = (taskId: string): Entry => entries.get(taskId) ?? { snapshot: EMPTY };
  const publish = (taskId: string, entry: Entry) => {
    entries.set(taskId, { ...entry, snapshot: Object.freeze(entry.snapshot) });
    // Snapshot listener membership: detaching a drawer does not mutate request
    // ownership, and a subscriber added during a notification starts next time.
    for (const listener of [...listeners]) listener();
  };
  const matches = (entry: Entry, pending: PendingMessage) => entry.pending?.operationId === pending.operationId;
  const unchanged = (entry: Entry, pending: PendingMessage) => entry.snapshot.revision === pending.revision && entry.snapshot.content === pending.content;

  return {
    getSnapshot(taskId) { return read(taskId).snapshot; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setContent(taskId, content) {
      const current = read(taskId);
      publish(taskId, { ...current, snapshot: { ...current.snapshot, content, revision: current.snapshot.revision + 1, error: '', sent: false } });
    },
    async send(taskId, admission = {}) {
      const current = read(taskId);
      if (current.pending || admission.allowed === false || !current.snapshot.content.trim()) return false;
      const pending: PendingMessage = { operationId: ++sequence, content: current.snapshot.content, revision: current.snapshot.revision };
      // Install the per-task lock synchronously, before invoking user transport
      // or awaiting anything, so remounts and repeated submit events share it.
      publish(taskId, { pending, snapshot: { ...current.snapshot, busy: true, error: '', sent: false } });
      try {
        await options.send(taskId, pending.content.trim());
      } catch (error) {
        const latest = read(taskId);
        if (matches(latest, pending)) {
          publish(taskId, { snapshot: { ...latest.snapshot, busy: false, sent: false,
            error: unchanged(latest, pending) ? (error instanceof Error && error.message ? error.message : '发送失败，请重试') : latest.snapshot.error } });
        }
        return false;
      }
      const latest = read(taskId);
      if (!matches(latest, pending)) return false;
      const sameDraft = unchanged(latest, pending);
      publish(taskId, { snapshot: { ...latest.snapshot, content: sameDraft ? '' : latest.snapshot.content, busy: false, error: '', sent: sameDraft } });
      // Delivery is already confirmed. A refresh/observer failure must not turn
      // it into an uncertain send, and no old completion writes after observers.
      try { void Promise.resolve(options.onSent?.(taskId)).catch(() => undefined); }
      catch { /* A synchronous observer error cannot revoke confirmed delivery. */ }
      return true;
    },
  };
}

/** A stable external snapshot lets a newly mounted drawer resume the same draft. */
export function useBossMessageComposer(store: BossMessageComposer, taskId: string): BossMessageDraft {
  const getSnapshot = useCallback(() => store.getSnapshot(taskId), [store, taskId]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
