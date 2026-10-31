import { afterEach, expect, it, vi } from 'vitest';
import { createConnectionVerification } from './connection-verification';
import { HttpError } from './http-error';

afterEach(() => vi.useRealTimers());
const job = { id: 'verification-1', modelId: 'lead-model', reasoningEffort: 'high', state: 'running' as const, createdAt: '2026-10-29T00:00:00Z' };
for (const status of [400, 409]) it(`releases a definitively rejected ${status} request for explicit editing`, async () => {
  const start = vi.fn().mockRejectedValueOnce(new HttpError('模型身份不唯一', status, true)).mockResolvedValue({ ...job, modelId: 'correct-model', state: 'succeeded' });
  const store = createConnectionVerification({ start, read: vi.fn() });
  await store.start('lead-model', 'high');
  expect(store.getSnapshot().error).toBe('模型身份不唯一');
  expect(store.getSnapshot().pending).toBeNull(); expect(store.getSnapshot().uncertain).toBe(false);
  expect(start).toHaveBeenCalledTimes(1);
  await store.start('correct-model', 'high');
  expect(start.mock.calls[1]?.[0]).toBe('correct-model');
  expect(start.mock.calls[1]?.[2]).not.toBe(start.mock.calls[0]?.[2]); store.dispose();
});
for (const [status, flag] of [[409, false], [503, true], [500, false]] as const) it(`retains unknown ${status} response identity with flag=${flag}`, async () => {
  const start = vi.fn().mockRejectedValue(new HttpError('未确认', status, flag));
  const store = createConnectionVerification({ start, read: vi.fn() });
  await store.start('lead-model', 'high');
  expect(store.getSnapshot().uncertain).toBe(true);
  await store.start('different-model', 'high'); expect(start).toHaveBeenCalledTimes(1);
  await store.retry(); expect(start.mock.calls[1]).toEqual(start.mock.calls[0]); store.dispose();
});
it('locks duplicate clicks and keeps an uncertain request on its original identity', async () => {
  let reject!: (e: Error) => void;
  const start = vi.fn().mockImplementationOnce(() => new Promise((_, no) => { reject = no; })).mockResolvedValue({ ...job, state: 'failed', error: 'Authentication required' });
  const store = createConnectionVerification({ start, read: vi.fn() });
  const first = store.start('lead-model', 'high');
  await store.start('other-model', 'low');
  expect(start).toHaveBeenCalledTimes(1);
  reject(new Error('Network lost')); await first;
  expect(store.getSnapshot().uncertain).toBe(true);
  await store.retry();
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[1]).toEqual(start.mock.calls[0]);
  expect(store.getSnapshot().job?.state).toBe('failed');
  store.dispose();
});
it('recovers an accepted job through GET only and never repeats a model call', async () => {
  vi.useFakeTimers();
  const start = vi.fn().mockResolvedValue(job);
  const read = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ ...job, state: 'succeeded' });
  const store = createConnectionVerification({ start, read });
  await store.start('lead-model', 'high');
  await vi.advanceTimersByTimeAsync(1100);
  expect(store.getSnapshot().error).toBe('Offline');
  await store.retry();
  expect(store.getSnapshot().job?.state).toBe('succeeded');
  expect(start).toHaveBeenCalledTimes(1);
  store.dispose();
});
it('requires a new explicit action after interrupted or failed verification', async () => {
  const start = vi.fn().mockResolvedValue({ ...job, state: 'interrupted' });
  const read = vi.fn();
  const store = createConnectionVerification({ start, read });
  await store.start('lead-model', 'high');
  const original = start.mock.calls[0]![2];
  expect(read).not.toHaveBeenCalled();
  await store.start('lead-model', 'high');
  expect(start.mock.calls[1]![2]).not.toBe(original);
  store.dispose();
});

it('checks the backend-bound request alias without trusting unrelated canonical results', async () => {
  const start = vi.fn().mockResolvedValueOnce({ ...job, modelId: 'canonical', requestedModelIds: ['lead-model'], state: 'succeeded' })
    .mockResolvedValue({ ...job, modelId: 'canonical', requestedModelIds: ['someone-else'], state: 'succeeded' });
  const store = createConnectionVerification({ start, read: vi.fn() });
  await store.start('lead-model', 'high');
  expect(store.getSnapshot().job?.modelId).toBe('canonical');
  await store.start('lead-model', 'high');
  expect(store.getSnapshot().error).toContain('不匹配');
  expect(store.getSnapshot().uncertain).toBe(true);
  store.dispose();
});

it('restores accepted jobs by GET only and retains unknown POST identity without auto retry', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const start = vi.fn().mockResolvedValue(job); const read = vi.fn().mockResolvedValue({ ...job, state: 'succeeded' });
  const first = createConnectionVerification({ start, read }, storage);
  await first.start('lead-model', 'high'); first.dispose();
  const restored = createConnectionVerification({ start, read }, storage);
  restored.resume(); await vi.waitFor(() => expect(restored.getSnapshot().job?.state).toBe('succeeded'));
  expect(start).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledWith(job.id);
  restored.dispose();
  const uncertainStart = vi.fn().mockRejectedValue(new Error('Offline'));
  const unknown = createConnectionVerification({ start: uncertainStart, read }, storage);
  await unknown.start('lead-model', 'high'); const original = uncertainStart.mock.calls[0]; unknown.dispose();
  const unknownRestored = createConnectionVerification({ start: uncertainStart, read }, storage);
  unknownRestored.resume(); expect(uncertainStart).toHaveBeenCalledTimes(1);
  await unknownRestored.retry(); expect(uncertainStart.mock.calls[1]).toEqual(original);
  unknownRestored.dispose();
});

it('ignores late responses after disposal and refuses a different job on result reads', async () => {
  let finish!: (value: typeof job) => void;
  const late = createConnectionVerification({ start: vi.fn().mockReturnValue(new Promise(resolve => { finish = resolve; })), read: vi.fn() });
  const pending = late.start('lead-model', 'high'); late.dispose(); finish(job); await pending;
  expect(late.getSnapshot().job).toBeNull();
  const store = createConnectionVerification({ start: vi.fn().mockResolvedValue(job), read: vi.fn().mockResolvedValue({ ...job, id: 'unrelated', state: 'succeeded' }) });
  await store.start('lead-model', 'high'); await store.retry();
  expect(store.getSnapshot().error).toContain('不匹配');
  expect(store.getSnapshot().pending?.jobId).toBe(job.id);
  store.dispose();
});

it('initializes defaults once and keeps edited or blank drafts in memory only', () => {
  const storage = { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn(), removeItem: vi.fn() };
  const store = createConnectionVerification({ start: vi.fn(), read: vi.fn() }, storage);
  store.initializeDraft({ codex: { available: true, models: [{ id: 'first-model', label: 'First' }], reasoningEfforts: ['low'] } });
  expect(store.getSnapshot().draft).toEqual({ modelId: 'first-model', reasoningEffort: 'low' });
  store.initializeDraft({ codex: { available: true, models: [{ id: 'later-model', label: 'Later' }], reasoningEfforts: ['high'] } });
  expect(store.getSnapshot().draft).toEqual({ modelId: 'first-model', reasoningEffort: 'low' });
  store.editDraft({ modelId: '' });
  store.initializeDraft({ codex: { available: true, models: [{ id: 'later-model', label: 'Later' }], reasoningEfforts: ['high'] } });
  expect(store.getSnapshot().draft).toEqual({ modelId: '', reasoningEffort: 'low' });
  expect(storage.setItem).not.toHaveBeenCalled();
  store.dispose();
});
