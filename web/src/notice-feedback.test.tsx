import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { api } from './api';
vi.mock('./api', () => ({ api: { tasks: vi.fn(), task: vi.fn(), capabilities: vi.fn(), sequences: vi.fn(), sequence: vi.fn(), retrySequenceGoalReview: vi.fn(), config: vi.fn(), cancelTask: vi.fn(), createTask: vi.fn(), createSequence: vi.fn(), saveConfig: vi.fn() } }));
const config = { allocator: { kind: 'api' as const, modelId: null, reasoningEffort: null, api: { baseUrl: 'https://provider.example/v1', model: 'initial-model', keyEnv: 'ZERO_ROUTER_KEY' } }, reviewer: { modelId: null, reasoningEffort: null } };
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  vi.mocked(api.tasks).mockResolvedValue([]); vi.mocked(api.sequences).mockResolvedValue([]);
  vi.mocked(api.capabilities).mockResolvedValue({ harnesses: [], bindings: [], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } });
  vi.mocked(api.config).mockResolvedValue(config);
  vi.mocked(api.saveConfig).mockImplementation(async value => value);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function openSettings() {
  const rendered = render(<App />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '路由设置' })); await act(async () => {});
  return rendered;
}
async function saveModel(model: string) {
  fireEvent.change(screen.getByLabelText('API 模型'), { target: { value: model } });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' })); await act(async () => {});
}
it('gives each successful save a fresh 3200ms global notice even when the text repeats', async () => {
  await openSettings();
  await saveModel('first-model');
  expect(screen.getByRole('status').textContent).toBe('路由设置已保存');
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  await saveModel('second-model');
  expect(api.saveConfig).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: '已保存' })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('路由设置已保存');
  await act(async () => { await vi.advanceTimersByTimeAsync(201); });
  const record = { elapsedSinceFirstSaveMs: 3201, elapsedSinceSecondSaveMs: 201, savedConfigs: vi.mocked(api.saveConfig).mock.calls.map(call => call[0].allocator.api?.model), globalNotice: screen.queryByRole('status')?.textContent ?? null, localSaveButton: screen.getByRole('button', { name: '已保存' }).textContent };
  expect(record.globalNotice).toBe('路由设置已保存');
  await act(async () => { await vi.advanceTimersByTimeAsync(2998); });
  expect(screen.getByRole('status').textContent).toBe('路由设置已保存');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.queryByRole('status')).toBeNull();
});
it('expires a single save notice at 3200ms and cleans polling/feedback timers on unmount', async () => {
  const { unmount } = await openSettings(); await saveModel('one-model');
  await act(async () => { await vi.advanceTimersByTimeAsync(3199); });
  expect(screen.getByRole('status')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.queryByRole('status')).toBeNull();
  await saveModel('another-model'); expect(screen.getByRole('status')).toBeTruthy();
  unmount(); expect(vi.getTimerCount()).toBe(0);
});
it('replaces a save notice with a different success message for a fresh full interval', async () => {
  await openSettings(); await saveModel('saved-before-submit');
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  const task = { id: 'created-task', title: '新提交的任务', status: 'pending' as const };
  vi.mocked(api.createTask).mockResolvedValue(task); vi.mocked(api.task).mockResolvedValue(task);
  fireEvent.click(screen.getByRole('button', { name: '任务工作台' }));
  fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
  fireEvent.change(screen.getByLabelText(/仓库路径/), { target: { value: 'C:/repo/zero' } });
  fireEvent.change(screen.getByLabelText('任务描述 *'), { target: { value: 'Verify the next successful operation.' } });
  fireEvent.change(screen.getByLabelText(/检查命令/), { target: { value: 'npm test' } });
  fireEvent.click(screen.getByRole('button', { name: '加入任务队列' })); await act(async () => {});
  expect(screen.getByRole('status').textContent).toBe('任务已加入队列');
  await act(async () => { await vi.advanceTimersByTimeAsync(201); });
  expect(screen.getByRole('status').textContent).toBe('任务已加入队列');
  await act(async () => { await vi.advanceTimersByTimeAsync(2998); });
  expect(screen.getByRole('status').textContent).toBe('任务已加入队列');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.queryByRole('status')).toBeNull();
});
