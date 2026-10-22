import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { Config } from './types';

vi.mock('./api', () => ({ api: {
  tasks: vi.fn(), task: vi.fn(), capabilities: vi.fn(), sequences: vi.fn(), sequence: vi.fn(),
  retrySequenceGoalReview: vi.fn(), config: vi.fn(), cancelTask: vi.fn(), createTask: vi.fn(),
  createSequence: vi.fn(), saveConfig: vi.fn(),
} }));

const config: Config = {
  allocator: { kind: 'api', modelId: null, reasoningEffort: null,
    api: { baseUrl: 'https://router.example/v1', model: 'initial-model', keyEnv: 'ZERO_ROUTER_KEY' } },
  reviewer: { modelId: null, reasoningEffort: null },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.tasks).mockResolvedValue([]);
  vi.mocked(api.sequences).mockResolvedValue([]);
  vi.mocked(api.config).mockResolvedValue(structuredClone(config));
  vi.mocked(api.capabilities).mockResolvedValue({ harnesses: [], bindings: [],
    allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } });
  vi.mocked(api.saveConfig).mockImplementation(async value => structuredClone(value));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

async function openSettings() {
  const view = render(<App />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '路由设置' }));
  await act(async () => {});
  return view;
}

async function save() {
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  await act(async () => {});
  expect(screen.getByRole('button', { name: '已保存' })).toBeTruthy();
}

it('stops claiming that edited settings are saved and immediately saves the new draft', async () => {
  await openSettings();
  await save();
  fireEvent.change(screen.getByLabelText('API 模型'), { target: { value: 'edited-after-save' } });
  const button = screen.queryByRole('button', { name: '保存设置' });
  expect(button, 'editing must replace the saved acknowledgement with an enabled save action').not.toBeNull();
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole('button', { name: '已保存' })).toBeNull();
  await save();
  expect(api.saveConfig).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.saveConfig).mock.calls[1]?.[0].allocator.api?.model).toBe('edited-after-save');
});

it('keeps the latest save acknowledgement for its own duration and clears timers when leaving settings', async () => {
  await openSettings();
  await save();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  fireEvent.change(screen.getByLabelText('API 模型'), { target: { value: 'second-model' } });
  expect(screen.queryByRole('button', { name: '保存设置' })).not.toBeNull();
  await save();
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  expect(screen.queryByRole('button', { name: '已保存' }), 'the first save timer must not expire the second acknowledgement').not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(screen.queryByRole('button', { name: '已保存' })).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.queryByRole('button', { name: '保存设置' })).not.toBeNull();

  await save();
  const beforeLeaving = vi.getTimerCount();
  fireEvent.click(screen.getByRole('button', { name: '任务工作台' }));
  expect(vi.getTimerCount()).toBe(beforeLeaving - 1);
});
