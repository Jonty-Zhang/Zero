import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import type { TaskSequence } from './types';
const rejection = '旧 blocked attempt 的重新验收服务暂不可用';
const oldAttempt = 'blocked-attempt-old'; const newAttempt = 'review-attempt-new';
let sequence: TaskSequence;
let post: () => Response | Promise<Response>;
const requests: Array<{ path: string; method: string; body: unknown }> = [];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  vi.useFakeTimers(); requests.length = 0;
  sequence = { id: 'goal-sequence', objective: '整体验收重试来源', status: 'blocked', maxGoalRevisions: 2, goalRevisionCount: 0, createdAt: '', updatedAt: '', steps: [{ position: 0, task: { id: 'done-step', status: 'done' } }], goalReview: { state: 'verdict', attemptId: oldAttempt, createdAt: '', result: { verdict: 'blocked', summary: '旧审核器错误', findings: [] } } };
  post = () => response({ error: rejection }, 503);
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input); const method = init?.method ?? 'GET';
    requests.push({ path, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (path === '/api/tasks') return response([]);
    if (path === '/api/sequences') return response([sequence]);
    if (path === '/api/config') return response({ allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } });
    if (path === '/api/capabilities') return response({ harnesses: [], bindings: [], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } });
    if (path === '/api/sequences/goal-sequence') return response(sequence);
    if (path === '/api/sequences/goal-sequence/goal-review/retry' && method === 'POST') return await post();
    throw new Error(`Unexpected request: ${method} ${path}`);
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function open() {
  render(<App />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /^整体验收重试来源/ })); await act(async () => {});
  return screen.getByRole('dialog', { name: '目标进度' });
}
function snapshot(dialog: HTMLElement) {
  return { attemptId: sequence.goalReview?.attemptId, reviewState: sequence.goalReview?.state, verdict: sequence.goalReview?.result?.verdict ?? null,
    displayedState: dialog.querySelector('.drawer-status-row .sequence-state')?.textContent,
    callout: dialog.querySelector('.sequence-goal-callout')?.textContent,
    alert: within(dialog).queryByRole('alert')?.textContent ?? null };
}
function running() { sequence = { ...sequence, status: 'steps_completed', goalReview: { state: 'running', attemptId: newAttempt, createdAt: '' } }; }
it('does not retain an old retry POST error when polls advance to another running attempt and then pass', async () => {
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '重新验收' })); await act(async () => {});
  expect(within(dialog).getByRole('alert').textContent).toContain(rejection);
  running(); await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
  expect(within(dialog).getByText('正在进行目标级 Codex 验收')).toBeTruthy();
  const active = snapshot(dialog);
  sequence = { ...sequence, status: 'completed', goalReview: { state: 'verdict', attemptId: newAttempt, createdAt: '', result: { verdict: 'pass', summary: '新验收已通过', findings: [] } } };
  await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
  expect(within(dialog).getByText('目标验收：PASS')).toBeTruthy();
  expect(within(dialog).getByText('新验收已通过')).toBeTruthy();
  const passed = snapshot(dialog);
  expect({ runningError: active.alert, passedError: passed.alert }).toEqual({ runningError: null, passedError: null });
});
it('does not attach a held old POST 503 to a new attempt that polling already observed', async () => {
  let release!: (value: Response) => void;
  post = () => new Promise<Response>(resolve => { release = resolve; });
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '重新验收' })); await act(async () => {});
  expect(within(dialog).getByRole('button', { name: '正在提交重新验收…' })).toBeTruthy();
  running(); await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
  expect(within(dialog).getByText('正在进行目标级 Codex 验收')).toBeTruthy();
  await act(async () => release(response({ error: rejection }, 503)));
  const afterRelease = snapshot(dialog);
  expect(within(dialog).getByText('正在进行目标级 Codex 验收')).toBeTruthy();
  expect(afterRelease.alert).toBeNull();
});
it('allows retrying the current blocked attempt while an old attempt POST is still held', async () => {
  let release!: (value: Response) => void;
  post = () => new Promise<Response>(resolve => { release = resolve; });
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '重新验收' })); await act(async () => {});
  running(); await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
  sequence = { ...sequence, status: 'blocked', goalReview: { state: 'verdict', attemptId: newAttempt, createdAt: '', result: { verdict: 'blocked', summary: '新一轮验收器阻塞', findings: [] } } };
  await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
  expect(within(dialog).getByText('新一轮验收器阻塞')).toBeTruthy();
  const button = within(dialog).getByRole('button', { name: /重新验收/ }) as HTMLButtonElement;
  const beforeRelease = { ...snapshot(dialog), retryButtonText: button.textContent, retryDisabled: button.disabled, queuedStatus: within(dialog).queryByRole('status')?.textContent ?? null };
  await act(async () => release(response({ error: rejection }, 503)));
  expect({ retryButtonText: beforeRelease.retryButtonText, retryDisabled: beforeRelease.retryDisabled, queuedStatus: beforeRelease.queuedStatus }).toEqual({ retryButtonText: '重新验收', retryDisabled: false, queuedStatus: null });
});
it('keeps a current-attempt failure visible and permits retrying that same attempt', async () => {
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '重新验收' })); await act(async () => {});
  expect(within(dialog).getByRole('alert').textContent).toContain(rejection);
  const button = within(dialog).getByRole('button', { name: '重新验收' }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  post = () => response(sequence, 202);
  fireEvent.click(button); await act(async () => {});
  expect(within(dialog).queryByRole('alert')).toBeNull();
  expect(within(dialog).getByRole('status').textContent).toContain('重新验收已排队');
  expect(requests.filter(request => request.method === 'POST').map(request => request.body)).toEqual([{ attemptId: oldAttempt }, { attemptId: oldAttempt }]);
});
it.each(['old503-first', 'old202-first', 'old202-last'] as const)('isolates concurrent retry response order: %s', async order => {
  const releases: Array<(value: Response) => void> = [];
  post = () => new Promise<Response>(resolve => { releases.push(resolve); });
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '重新验收' })); await act(async () => {});
  running(); await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
  sequence = { ...sequence, status: 'blocked', goalReview: { state: 'verdict', attemptId: newAttempt, createdAt: '', result: { verdict: 'blocked', summary: '新一轮验收器阻塞', findings: [] } } };
  await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
  const button = within(dialog).getByRole('button', { name: /重新验收/ }) as HTMLButtonElement;
  fireEvent.click(button); await act(async () => {});
  const posted = requests.filter(request => request.method === 'POST').map(request => request.body);
  if (releases.length !== 2) {
    await act(async () => releases[0](response({ error: rejection }, 503)));
    expect(posted).toEqual([{ attemptId: oldAttempt }, { attemptId: newAttempt }]);
    return;
  }
  if (order === 'old202-last') {
    await act(async () => releases[1](response(sequence, 202)));
    expect(within(dialog).getByRole('status').textContent).toContain('重新验收已排队');
    await act(async () => releases[0](response(sequence, 202)));
  } else {
    await act(async () => releases[0](order === 'old503-first' ? response({ error: rejection }, 503) : response(sequence, 202)));
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).queryByRole('status')).toBeNull();
    expect((within(dialog).getByRole('button', { name: '正在提交重新验收…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => releases[1](response(sequence, 202)));
  }
  expect(within(dialog).queryByRole('alert')).toBeNull();
  expect(within(dialog).getByRole('status').textContent).toContain('重新验收已排队');
  expect((within(dialog).getByRole('button', { name: '重新验收' }) as HTMLButtonElement).disabled).toBe(true);
  expect(posted).toEqual([{ attemptId: oldAttempt }, { attemptId: newAttempt }]);
});
