import { describe, expect, it, vi } from 'vitest';
import { createBossMessageComposer } from './boss-message-composer';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('read-only message confirmation custody', () => {
  it('only confirms a previously failed exact payload and never falls back to sending', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Response lost'));
    const confirm = vi.fn().mockResolvedValue({ id: 'receipt' });
    const store = createBossMessageComposer({ send, confirm });
    store.setContent('A', 'Original');
    expect(await store.confirm('A')).toBe(false);
    expect(await store.send('A')).toBe(false);
    expect(store.getSnapshot('A').canConfirm).toBe(true);
    expect(await store.confirm('B')).toBe(false);
    store.setContent('A', 'Changed');
    expect(store.getSnapshot('A').canConfirm).toBe(false);
    expect(await store.confirm('A')).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    store.setContent('A', '  Original  ');
    expect(await store.confirm('A')).toBe(true);
    expect(confirm).toHaveBeenCalledExactlyOnceWith('A', 'Original');
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('A')).toMatchObject({ content: '', sent: true, canConfirm: false });
    expect(await store.confirm('A')).toBe(false);
  });

  it('does not offer confirmation without a dedicated receipt transport', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Response lost'));
    const store = createBossMessageComposer({ send });
    store.setContent('A', 'Uncertain');
    await store.send('A');
    expect(store.getSnapshot('A').canConfirm).toBe(false);
    expect(await store.confirm('A')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('shares the synchronous task lock between confirmation and normal resending', async () => {
    const pending = deferred();
    const send = vi.fn().mockRejectedValue(new Error('Response lost'));
    const confirm = vi.fn(() => pending.promise);
    const onSent = vi.fn();
    const store = createBossMessageComposer({ send, confirm, onSent });
    store.setContent('A', 'Original');
    await store.send('A');
    const first = store.confirm('A');
    expect(store.getSnapshot('A').busy).toBe(true);
    expect(await store.confirm('A')).toBe(false);
    expect(await store.send('A')).toBe(false);
    pending.resolve();
    expect(await first).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledExactlyOnceWith('A');
  });

  it.each(['success', 'failure'] as const)('an older confirmation %s cannot clear a newer A draft or modify B', async outcome => {
    const pending = deferred();
    const store = createBossMessageComposer({ send: vi.fn().mockRejectedValue(new Error('Response lost')), confirm: () => pending.promise });
    store.setContent('A', 'Original');
    await store.send('A');
    const confirmation = store.confirm('A');
    store.setContent('A', 'New draft');
    store.setContent('B', 'Other task draft');
    if (outcome === 'success') pending.resolve(); else pending.reject(new Error('Old confirmation failed'));
    expect(await confirmation).toBe(outcome === 'success');
    expect(store.getSnapshot('A')).toMatchObject({ content: 'New draft', busy: false, sent: false, error: '', canConfirm: false });
    expect(store.getSnapshot('B')).toMatchObject({ content: 'Other task draft', busy: false, sent: false, error: '' });
  });

  it('a missing receipt keeps the draft available for confirmation without adding a message', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Response lost'));
    const confirm = vi.fn().mockRejectedValue(new Error('No receipt yet'));
    const store = createBossMessageComposer({ send, confirm });
    store.setContent('A', '  Original\n中文  ');
    await store.send('A');
    expect(await store.confirm('A')).toBe(false);
    expect(store.getSnapshot('A')).toMatchObject({ content: '  Original\n中文  ', sent: false, busy: false, error: 'No receipt yet', canConfirm: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledExactlyOnceWith('A', 'Original\n中文');
  });
});
