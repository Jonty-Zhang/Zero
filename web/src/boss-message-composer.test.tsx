import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBossMessageComposer, useBossMessageComposer, type BossMessageComposer } from './boss-message-composer';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function ComposerView({ store, taskId, allowed = true }: { store: BossMessageComposer; taskId: string; allowed?: boolean }) {
  const draft = useBossMessageComposer(store, taskId);
  return <section>
    <textarea aria-label="draft" value={draft.content} onChange={event => store.setContent(taskId, event.target.value)} />
    <button disabled={draft.busy || !allowed} onClick={() => { void store.send(taskId, { allowed }); }}>send</button>
    <output aria-label="busy">{String(draft.busy)}</output>
    <output aria-label="receipt">{String(draft.sent)}</output>
    {draft.error && <p role="alert">{draft.error}</p>}
  </section>;
}

describe('task-scoped supplementary-message ownership', () => {
  it('preserves exact drafts and isolates task IDs without writing browser storage', () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const store = createBossMessageComposer({ send: vi.fn() });
    const raw = '  原任务\n保留完整实验记录。  ';
    store.setContent('A', raw);
    store.setContent('B', 'Other project');
    expect(store.getSnapshot('A').content).toBe(raw);
    expect(store.getSnapshot('B').content).toBe('Other project');
    expect(store.getSnapshot('C').content).toBe('');
    expect(local).not.toHaveBeenCalled();
    local.mockRestore();
  });

  it('uses stable immutable snapshots until that task changes', () => {
    const store = createBossMessageComposer({ send: vi.fn() });
    const empty = store.getSnapshot('A');
    expect(store.getSnapshot('A')).toBe(empty);
    store.setContent('B', 'B');
    expect(store.getSnapshot('A')).toBe(empty);
    store.setContent('A', 'A');
    expect(store.getSnapshot('A')).not.toBe(empty);
    expect(Object.isFrozen(store.getSnapshot('A'))).toBe(true);
  });

  it('closes the same-task lock synchronously, before the first send promise settles', async () => {
    const pending = deferred();
    const send = vi.fn(() => pending.promise);
    const onSent = vi.fn();
    const store = createBossMessageComposer({ send, onSent });
    store.setContent('A', '  Requirement A  ');
    const first = store.send('A');
    expect(store.getSnapshot('A').busy).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith('A', 'Requirement A');
    expect(await store.send('A')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    pending.resolve();
    expect(await first).toBe(true);
    expect(onSent).toHaveBeenCalledExactlyOnceWith('A');
    expect(store.getSnapshot('A')).toMatchObject({ content: '', busy: false, sent: true, error: '' });
  });

  it('does not submit empty drafts or requests whose current admission is closed', async () => {
    const send = vi.fn();
    const store = createBossMessageComposer({ send });
    expect(await store.send('A')).toBe(false);
    store.setContent('A', ' \n ');
    expect(await store.send('A')).toBe(false);
    store.setContent('A', 'Keep me');
    expect(await store.send('A', { allowed: false })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(store.getSnapshot('A')).toMatchObject({ content: 'Keep me', busy: false, sent: false });
  });

  it('only clears the submitted revision and preserves a newer same-task draft', async () => {
    const pending = deferred();
    const store = createBossMessageComposer({ send: () => pending.promise });
    store.setContent('A', 'old');
    const request = store.send('A');
    const submittedRevision = store.getSnapshot('A').revision;
    store.setContent('A', 'new');
    store.setContent('B', 'B must remain');
    expect(store.getSnapshot('A')).toMatchObject({ content: 'new', busy: true, sent: false });
    pending.resolve();
    expect(await request).toBe(true);
    expect(store.getSnapshot('A')).toMatchObject({ content: 'new', revision: submittedRevision + 1, busy: false, sent: false });
    expect(store.getSnapshot('B').content).toBe('B must remain');
  });

  it('does not clear an edited-and-reverted draft that happens to equal the submitted text', async () => {
    const pending = deferred();
    const store = createBossMessageComposer({ send: () => pending.promise });
    store.setContent('A', 'same');
    const request = store.send('A');
    store.setContent('A', 'different');
    store.setContent('A', 'same');
    pending.resolve();
    await request;
    expect(store.getSnapshot('A')).toMatchObject({ content: 'same', busy: false, sent: false, revision: 3 });
  });

  it('preserves timeout drafts verbatim and retries the same task/content through the injected API', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('请求超时，请检查 Zero 服务后重试')).mockResolvedValueOnce({ received: true });
    const onSent = vi.fn();
    const store = createBossMessageComposer({ send, onSent });
    const raw = '  保留我\n下一行  ';
    store.setContent('A', raw);
    expect(await store.send('A')).toBe(false);
    expect(store.getSnapshot('A')).toMatchObject({ content: raw, busy: false, sent: false, error: '请求超时，请检查 Zero 服务后重试' });
    expect(onSent).not.toHaveBeenCalled();
    expect(await store.send('A')).toBe(true);
    expect(send.mock.calls).toEqual([['A', raw.trim()], ['A', raw.trim()]]);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('an old failure cannot overwrite a newer edit with stale error presentation', async () => {
    const pending = deferred();
    const store = createBossMessageComposer({ send: () => pending.promise });
    store.setContent('A', 'before');
    const request = store.send('A');
    store.setContent('A', 'after');
    pending.reject(new Error('Failure belongs to before'));
    expect(await request).toBe(false);
    expect(store.getSnapshot('A')).toMatchObject({ content: 'after', busy: false, error: '', sent: false });
  });

  it.each(['AB', 'BA'])('allows independent task sends and settles them in %s order', async order => {
    const a = deferred();
    const b = deferred();
    const send = vi.fn((taskId: string) => taskId === 'A' ? a.promise : b.promise);
    const store = createBossMessageComposer({ send });
    store.setContent('A', 'a'); store.setContent('B', 'b');
    const requests = { A: store.send('A'), B: store.send('B') };
    const gates = { A: a, B: b };
    const first = order[0] as 'A' | 'B';
    const last = order[1] as 'A' | 'B';
    gates[first].resolve();
    expect(await requests[first]).toBe(true);
    expect(store.getSnapshot(last)).toMatchObject({ busy: true, content: last.toLowerCase(), sent: false });
    gates[last].resolve();
    expect(await requests[last]).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('handles synchronous transport exceptions without leaving a permanent task lock', async () => {
    const send = vi.fn().mockImplementationOnce(() => { throw new Error('Immediate failure'); }).mockResolvedValueOnce(undefined);
    const store = createBossMessageComposer({ send });
    store.setContent('A', 'retry');
    expect(await store.send('A')).toBe(false);
    expect(store.getSnapshot('A')).toMatchObject({ content: 'retry', busy: false, error: 'Immediate failure' });
    expect(await store.send('A')).toBe(true);
  });

  it.each(['synchronous', 'asynchronous'])('does not turn accepted delivery into failure when refresh throws %s', async mode => {
    const onSent = mode === 'synchronous' ? () => { throw new Error('refresh failed'); } : async () => { throw new Error('refresh failed'); };
    const store = createBossMessageComposer({ send: async () => ({}), onSent });
    store.setContent('A', 'accepted');
    expect(await store.send('A')).toBe(true);
    await Promise.resolve();
    expect(store.getSnapshot('A')).toMatchObject({ content: '', busy: false, sent: true, error: '' });
  });

  it('allows confirmed onSent to start a new operation without the old completion unlocking or clearing it', async () => {
    const next = deferred();
    const send = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => next.promise);
    let second!: Promise<boolean>;
    const store = createBossMessageComposer({ send, onSent: () => {
      if (send.mock.calls.length === 1) { store.setContent('A', 'next draft'); second = store.send('A'); }
    } });
    store.setContent('A', 'original');
    expect(await store.send('A')).toBe(true);
    expect(store.getSnapshot('A')).toMatchObject({ content: 'next draft', busy: true, sent: false });
    expect(await store.send('A')).toBe(false);
    next.resolve();
    expect(await second).toBe(true);
  });

  it('subscriptions can detach without cancelling a pending request and do not receive later notifications', async () => {
    const pending = deferred();
    const onSent = vi.fn();
    const store = createBossMessageComposer({ send: () => pending.promise, onSent });
    const listener = vi.fn();
    const detach = store.subscribe(listener);
    store.setContent('A', 'kept across unmount');
    const request = store.send('A');
    detach();
    const calls = listener.mock.calls.length;
    pending.resolve(); await request;
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(onSent).toHaveBeenCalledExactlyOnceWith('A');
    expect(store.getSnapshot('A').sent).toBe(true);
  });
});

describe('React subscription across drawer lifetimes', () => {
  it('retains exact drafts across A unmount, B editing and A remount', () => {
    const store = createBossMessageComposer({ send: vi.fn() });
    const view = render(<ComposerView store={store} taskId="A" key="A" />);
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: '  A\nexact  ' } });
    view.rerender(<ComposerView store={store} taskId="B" key="B" />);
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'B draft' } });
    view.rerender(<ComposerView store={store} taskId="A" key="A" />);
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('  A\nexact  ');
    view.rerender(<ComposerView store={store} taskId="B" key="B" />);
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('B draft');
  });

  it('reopening pending A restores its lock, while completion never clears open B draft', async () => {
    const pending = deferred();
    const send = vi.fn(() => pending.promise);
    const store = createBossMessageComposer({ send });
    const view = render(<ComposerView store={store} taskId="A" key="A" />);
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'A request' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    view.rerender(<ComposerView store={store} taskId="B" key="B" />);
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'Do not erase B' } });
    view.rerender(<ComposerView store={store} taskId="A" key="A" />);
    expect((screen.getByRole('button', { name: 'send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('busy').textContent).toBe('true');
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('A request');
    view.rerender(<ComposerView store={store} taskId="B" key="B" />);
    await act(async () => { pending.resolve(); });
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('Do not erase B');
    expect(screen.getByLabelText('receipt').textContent).toBe('false');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a failure while unmounted reappears only on the original task', async () => {
    const pending = deferred();
    const store = createBossMessageComposer({ send: () => pending.promise });
    const view = render(<ComposerView store={store} taskId="A" key="A" />);
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'Retry exactly this' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    view.rerender(<ComposerView store={store} taskId="B" key="B" />);
    await act(async () => { pending.reject(new Error('timeout')); });
    expect(screen.queryByRole('alert')).toBeNull();
    view.rerender(<ComposerView store={store} taskId="A" key="A" />);
    expect(screen.getByRole('alert').textContent).toBe('timeout');
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('Retry exactly this');
  });

  it('admission/status changes do not erase a draft or fabricate a receipt', async () => {
    const send = vi.fn();
    const store = createBossMessageComposer({ send });
    const view = render(<ComposerView store={store} taskId="A" allowed />);
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'Hold after seal' } });
    view.rerender(<ComposerView store={store} taskId="A" allowed={false} />);
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('Hold after seal');
    expect((screen.getByRole('button', { name: 'send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByLabelText('receipt').textContent).toBe('false');
  });

  it('admission closing during a pending request preserves a rejected draft for later copying', async () => {
    const pending = deferred();
    const store = createBossMessageComposer({ send: () => pending.promise });
    const view = render(<ComposerView store={store} taskId="A" allowed />);
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'Received before seal?' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    view.rerender(<ComposerView store={store} taskId="A" allowed={false} />);
    await act(async () => { pending.reject(new Error('验收要求已封存')); });
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('Received before seal?');
    expect(screen.getByRole('alert').textContent).toBe('验收要求已封存');
    expect(screen.getByLabelText('receipt').textContent).toBe('false');
    expect((screen.getByRole('button', { name: 'send' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
