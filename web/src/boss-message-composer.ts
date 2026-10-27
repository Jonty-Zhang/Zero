import { useCallback, useSyncExternalStore } from 'react';

export interface BossMessageDraft {
  readonly content: string;
  readonly revision: number;
  readonly busy: boolean;
  readonly error: string;
  /** The visible, unchanged draft was confirmed delivered. */
  readonly sent: boolean;
  readonly canConfirm: boolean;
}

export interface BossMessageComposer {
  getSnapshot(taskId: string): BossMessageDraft;
  subscribe(listener: () => void): () => void;
  setContent(taskId: string, content: string): void;
  /** False for denied, duplicate or failed sends; only one actual delivery returns true. */
  send(taskId: string, options?: { allowed?: boolean }): Promise<boolean>;
  /** Read the receipt for an unchanged failed payload; never dispatch new work. */
  confirm(taskId: string): Promise<boolean>;
}

export interface BossMessageComposerOptions {
  send: (taskId: string, content: string) => Promise<unknown>;
  confirm?: (taskId: string, content: string) => Promise<unknown>;
  onSent?: (taskId: string) => void | Promise<void>;
}

interface PendingMessage { operationId: number; content: string; revision: number }
interface Entry { snapshot: BossMessageDraft; pending?: PendingMessage; unconfirmedContent?: string }

const EMPTY: BossMessageDraft = Object.freeze({ content: '', revision: 0, busy: false, error: '', sent: false, canConfirm: false });

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

  const deliver = async (taskId: string, allowed: boolean, confirmation: boolean): Promise<boolean> => {
    const current = read(taskId);
    const content = current.snapshot.content.trim();
    const transport = confirmation ? options.confirm : options.send;
    if (!transport || current.pending || !allowed || !content || (confirmation && current.unconfirmedContent !== content)) return false;
    const pending: PendingMessage = { operationId: ++sequence, content: current.snapshot.content, revision: current.snapshot.revision };
    // Sending and read-only confirmation share the per-task lock across mounts.
    publish(taskId, { ...current, pending, snapshot: { ...current.snapshot, busy: true, error: '', sent: false } });
    try {
      await transport(taskId, content);
    } catch (error) {
      const latest = read(taskId);
      if (matches(latest, pending)) {
        const unconfirmedContent = confirmation ? latest.unconfirmedContent : content;
        publish(taskId, { unconfirmedContent, snapshot: { ...latest.snapshot, busy: false, sent: false,
          canConfirm: !!options.confirm && latest.snapshot.content.trim() === unconfirmedContent,
          error: unchanged(latest, pending) ? (error instanceof Error && error.message ? error.message : '发送失败，请重试') : latest.snapshot.error } });
      }
      return false;
    }
    const latest = read(taskId);
    if (!matches(latest, pending)) return false;
    const sameDraft = unchanged(latest, pending);
    publish(taskId, { snapshot: { ...latest.snapshot, content: sameDraft ? '' : latest.snapshot.content,
      busy: false, error: '', sent: sameDraft, canConfirm: false } });
    // Refresh observers cannot revoke a confirmed receipt or unlock a newer call.
    try { void Promise.resolve(options.onSent?.(taskId)).catch(() => undefined); }
    catch { /* Synchronous observer errors do not change delivery evidence. */ }
    return true;
  };

  return {
    getSnapshot(taskId) { return read(taskId).snapshot; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setContent(taskId, content) {
      const current = read(taskId);
      publish(taskId, { ...current, snapshot: { ...current.snapshot, content, revision: current.snapshot.revision + 1, error: '', sent: false,
        canConfirm: !!options.confirm && current.unconfirmedContent === content.trim() } });
    },
    send(taskId, admission = {}) { return deliver(taskId, admission.allowed !== false, false); },
    confirm(taskId) { return deliver(taskId, true, true); },
  };
}

/** A stable external snapshot lets a newly mounted drawer resume the same draft. */
export function useBossMessageComposer(store: BossMessageComposer, taskId: string): BossMessageDraft {
  const getSnapshot = useCallback(() => store.getSnapshot(taskId), [store, taskId]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
