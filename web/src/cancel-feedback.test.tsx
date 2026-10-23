import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import type { Task } from './types';

const rejection = '取消请求暂不可用，请稍后重试';
let task: Task;
let cancelResponse: () => Response | Promise<Response>;
const requests: Array<{ path: string; method: string }> = [];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  vi.useFakeTimers(); requests.length = 0;
  task = { id: 'cancel-alpha', title: '取消反馈控制', status: 'running', repoPath: 'C:/fixture' };
  cancelResponse = () => response({ error: rejection }, 503);
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input); const method = init?.method ?? 'GET'; requests.push({ path, method });
    const other: Task = { id: 'cancel-beta', title: '另一个取消控制', status: 'running', repoPath: 'C:/fixture' };
    if (path === '/api/tasks') return response([task, other]);
    if (path === '/api/tasks/cancel-alpha') return response(task);
    if (path === '/api/tasks/cancel-beta') return response(other);
    if (path === '/api/tasks/cancel-alpha/cancel' && method === 'POST') return await cancelResponse();
    if (path === '/api/sequences') return response([]);
    if (path === '/api/config') return response({ allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } });
    if (path === '/api/capabilities') return response({ harnesses: [], bindings: [], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } });
    throw new Error(`Unexpected request: ${method} ${path}`);
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function open() {
  render(<App />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /^取消反馈控制/ })); await act(async () => {});
  return screen.getByRole('dialog', { name: '任务详情' });
}
const cancelRequests = () => requests.filter(request => request.method === 'POST');

it('shows a current cancellation failure and permits retrying the same running task', async () => {
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '取消任务' })); await act(async () => {});
  expect(within(dialog).getByText(rejection)).toBeTruthy();
  const retry = within(dialog).getByRole('button', { name: '取消任务' }) as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  cancelResponse = () => new Response(null, { status: 204 });
  fireEvent.click(retry); await act(async () => {});
  expect(within(dialog).queryByText(rejection)).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('已发送取消请求');
  expect(cancelRequests()).toEqual([{ path: '/api/tasks/cancel-alpha/cancel', method: 'POST' }, { path: '/api/tasks/cancel-alpha/cancel', method: 'POST' }]);
});

it.each(['done', 'failed', 'recovery_required'] as const)('hides an earlier cancellation failure when polling advances to %s', async status => {
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '取消任务' })); await act(async () => {});
  expect(within(dialog).getByText(rejection)).toBeTruthy();
  task = { ...task, status }; await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
  expect(dialog.querySelector('.drawer-status-row .status-pill')?.classList.contains(status)).toBe(true);
  expect(within(dialog).queryByRole('button', { name: '取消任务' })).toBeNull();
  expect(within(dialog).queryByText(rejection)).toBeNull();
  expect(cancelRequests()).toEqual([{ path: '/api/tasks/cancel-alpha/cancel', method: 'POST' }]);
});

it.each(['done', 'failed', 'recovery_required'] as const)('ignores late cancellation failure feedback after polling advances to %s', async status => {
  let release!: (value: Response) => void;
  cancelResponse = () => new Promise(resolve => { release = resolve; });
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '取消任务' })); await act(async () => {});
  expect(within(dialog).getByRole('button', { name: '正在取消…' })).toBeTruthy();
  task = { ...task, status }; await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
  expect(dialog.querySelector('.drawer-status-row .status-pill')?.classList.contains(status)).toBe(true);
  await act(async () => release(response({ error: rejection }, 503)));
  expect(within(dialog).queryByText(rejection)).toBeNull();
  expect(within(dialog).queryByRole('button', { name: '取消任务' })).toBeNull();
  expect(cancelRequests()).toEqual([{ path: '/api/tasks/cancel-alpha/cancel', method: 'POST' }]);
});

it('does not attach a closed drawer cancellation failure to another task', async () => {
  let release!: (value: Response) => void;
  cancelResponse = () => new Promise(resolve => { release = resolve; });
  const first = await open();
  fireEvent.click(within(first).getByRole('button', { name: '取消任务' })); await act(async () => {});
  fireEvent.click(within(first).getByRole('button', { name: '关闭详情' }));
  fireEvent.click(screen.getByRole('button', { name: /^另一个取消控制/ })); await act(async () => {});
  await act(async () => release(response({ error: rejection }, 503)));
  const second = screen.getByRole('dialog', { name: '任务详情' });
  expect(within(second).getByRole('heading', { name: '另一个取消控制' })).toBeTruthy();
  expect(within(second).queryByText(rejection)).toBeNull();
  expect((within(second).getByRole('button', { name: '取消任务' }) as HTMLButtonElement).disabled).toBe(false);
  expect(cancelRequests()).toEqual([{ path: '/api/tasks/cancel-alpha/cancel', method: 'POST' }]);
});
