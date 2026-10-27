// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { api } from './api';
import type { Task } from './types';
vi.mock('./api', () => ({ api: { tasks: vi.fn(), task: vi.fn(), capabilities: vi.fn(), sequences: vi.fn(), config: vi.fn(), messageTask: vi.fn() } }));
const first: Task = { id: 'boss-first', title: '正在推进的原项目', status: 'running', boss: { preference: '' }, bossMessages: [] };
const second: Task = { id: 'boss-second', title: '另一个独立项目', status: 'running', boss: { preference: '' }, bossMessages: [] };
const originalDraft = '  原项目的重要补充要求\n必须保留完整实验记录；不要合并其他项目的修改。  ';
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.tasks).mockResolvedValue([first, second]);
  vi.mocked(api.task).mockImplementation(async id => id === first.id ? first : second);
  vi.mocked(api.sequences).mockResolvedValue([]);
  vi.mocked(api.capabilities).mockResolvedValue({ harnesses: [], bindings: [], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } });
  vi.mocked(api.config).mockResolvedValue({ allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function openTask(title: string) {
  fireEvent.click(await screen.findByRole('button', { name: title }));
  const dialog = screen.getByRole('dialog', { name: '任务详情' });
  await within(dialog).findByLabelText('给 Boss 补充信息或提问');
  return dialog;
}
it.each(['not sent', 'timeout rejection'])('retains the original task message draft after real App navigation when %s', async state => {
  vi.mocked(api.messageTask).mockRejectedValue(new Error('请求超时，请检查 Zero 服务后重试'));
  render(<App />);
  const initialDialog = await openTask(first.title!);
  const input = within(initialDialog).getByLabelText('给 Boss 补充信息或提问') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: originalDraft } });
  if (state === 'timeout rejection') {
    fireEvent.click(within(initialDialog).getByRole('button', { name: '发送给 Boss' }));
    expect((await within(initialDialog).findByRole('alert')).textContent).toBe('请求超时，请检查 Zero 服务后重试');
    expect(api.messageTask).toHaveBeenCalledWith(first.id, originalDraft.trim());
  }
  expect(input.value).toBe(originalDraft);
  fireEvent.click(within(initialDialog).getByRole('button', { name: '关闭详情' }));
  const otherDialog = await openTask(second.title!);
  expect((within(otherDialog).getByLabelText('给 Boss 补充信息或提问') as HTMLTextAreaElement).value).toBe('');
  fireEvent.click(within(otherDialog).getByRole('button', { name: '关闭详情' }));
  const reopenedDialog = await openTask(first.title!);
  expect((within(reopenedDialog).getByLabelText('给 Boss 补充信息或提问') as HTMLTextAreaElement).value).toBe(originalDraft);
});
it('control: ordinary same-task status polling preserves an unsent draft while disabling review-time sends', async () => {
  vi.useFakeTimers();
  vi.mocked(api.task).mockResolvedValueOnce(first).mockResolvedValue({ ...first, status: 'reviewing' });
  render(<App />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: first.title! }));
  await act(async () => {});
  const input = screen.getByLabelText('给 Boss 补充信息或提问') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: originalDraft } });
  await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
  expect(api.task).toHaveBeenCalledTimes(2);
  expect(input.value).toBe(originalDraft);
  expect(input.disabled).toBe(true);
  expect(api.messageTask).not.toHaveBeenCalled();
});

function deferredDelivery() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
function messageInput(dialog: HTMLElement) {
  return within(dialog).getByLabelText('给 Boss 补充信息或提问') as HTMLTextAreaElement;
}
function closeTask(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭详情' }));
}

it('keeps an in-flight send busy after closing and reopening the actual task drawer and rejects duplicate submit events', async () => {
  const delivery = deferredDelivery();
  vi.mocked(api.messageTask).mockReturnValue(delivery.promise);
  render(<App />);
  let dialog = await openTask(first.title!);
  fireEvent.change(messageInput(dialog), { target: { value: originalDraft } });
  fireEvent.click(within(dialog).getByRole('button', { name: '发送给 Boss' }));
  expect(api.messageTask).toHaveBeenCalledTimes(1);
  closeTask(dialog);
  dialog = await openTask(second.title!);
  expect(messageInput(dialog).value).toBe('');
  expect(messageInput(dialog).disabled).toBe(false);
  closeTask(dialog);
  dialog = await openTask(first.title!);
  expect(messageInput(dialog).value).toBe(originalDraft);
  expect(messageInput(dialog).disabled).toBe(true);
  const sendingButton = within(dialog).getByRole('button', { name: '发送中…' }) as HTMLButtonElement;
  expect(sendingButton.disabled).toBe(true);
  fireEvent.submit(sendingButton.closest('form')!);
  fireEvent.submit(sendingButton.closest('form')!);
  expect(api.messageTask).toHaveBeenCalledTimes(1);
  await act(async () => { delivery.resolve({}); await delivery.promise; });
  expect(messageInput(dialog).disabled).toBe(false);
  expect(messageInput(dialog).value).toBe('');
  expect(within(dialog).getByText('已送达。')).toBeTruthy();
});

it.each(['success', 'failure'])('settles task A %s while task B is being edited without changing B content or receipt state', async outcome => {
  const delivery = deferredDelivery();
  vi.mocked(api.messageTask).mockReturnValue(delivery.promise);
  const otherDraft = '  另一个项目自己的要求\n不要被 A 的回执清空。  ';
  render(<App />);
  const firstDialog = await openTask(first.title!);
  fireEvent.change(messageInput(firstDialog), { target: { value: originalDraft } });
  fireEvent.click(within(firstDialog).getByRole('button', { name: '发送给 Boss' }));
  closeTask(firstDialog);
  const otherDialog = await openTask(second.title!);
  fireEvent.change(messageInput(otherDialog), { target: { value: otherDraft } });
  const detailCallsBeforeSettlement = vi.mocked(api.task).mock.calls.map(call => [...call]);
  await act(async () => {
    if (outcome === 'success') delivery.resolve({});
    else delivery.reject(new Error('A 的请求超时，保留原文'));
    await delivery.promise.catch(() => undefined);
  });
  expect(screen.getByRole('dialog', { name: '任务详情' })).toBe(otherDialog);
  expect(within(otherDialog).getByRole('heading', { name: second.title! })).toBeTruthy();
  expect(messageInput(otherDialog).value).toBe(otherDraft);
  expect(messageInput(otherDialog).disabled).toBe(false);
  expect(within(otherDialog).queryByRole('alert')).toBeNull();
  expect(within(otherDialog).queryByText('已送达。')).toBeNull();
  expect(api.messageTask).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.task).mock.calls).toEqual(detailCallsBeforeSettlement);
  closeTask(otherDialog);
  const reopened = await openTask(first.title!);
  expect(messageInput(reopened).value).toBe(outcome === 'success' ? '' : originalDraft);
  expect(messageInput(reopened).disabled).toBe(false);
  if (outcome === 'success') expect(within(reopened).getByText('已送达。')).toBeTruthy();
  else expect(within(reopened).getByRole('alert').textContent).toBe('A 的请求超时，保留原文');
  closeTask(reopened);
  expect(messageInput(await openTask(second.title!)).value).toBe(otherDraft);
});

it('retries an uncertain send after real navigation with the original trimmed payload and clears only after confirmation', async () => {
  vi.mocked(api.messageTask).mockRejectedValueOnce(new Error('请求超时，请检查 Zero 服务后重试')).mockResolvedValueOnce({});
  render(<App />);
  let dialog = await openTask(first.title!);
  fireEvent.change(messageInput(dialog), { target: { value: originalDraft } });
  fireEvent.click(within(dialog).getByRole('button', { name: '发送给 Boss' }));
  await within(dialog).findByRole('alert');
  expect(messageInput(dialog).value).toBe(originalDraft);
  closeTask(dialog);
  closeTask(await openTask(second.title!));
  dialog = await openTask(first.title!);
  expect(messageInput(dialog).value).toBe(originalDraft);
  fireEvent.click(within(dialog).getByRole('button', { name: '发送给 Boss' }));
  await within(dialog).findByText('已送达。');
  expect(api.messageTask).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.messageTask).mock.calls).toEqual([[first.id, originalDraft.trim()], [first.id, originalDraft.trim()]]);
  expect(messageInput(dialog).value).toBe('');
});

it('retains an unsubmitted draft across real navigation and polling that closes review-quota admission', async () => {
  vi.useFakeTimers();
  let sealed = false;
  vi.mocked(api.task).mockImplementation(async id => id === first.id ? { ...first, status: 'waiting', bossMessageAdmission: sealed ? 'closed' : 'open' } : second);
  render(<App />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: first.title! }));
  await act(async () => {});
  fireEvent.change(screen.getByLabelText('给 Boss 补充信息或提问'), { target: { value: originalDraft } });
  closeTask(screen.getByRole('dialog', { name: '任务详情' }));
  fireEvent.click(screen.getByRole('button', { name: second.title! }));
  await act(async () => {});
  closeTask(screen.getByRole('dialog', { name: '任务详情' }));
  fireEvent.click(screen.getByRole('button', { name: first.title! }));
  await act(async () => {});
  const dialog = screen.getByRole('dialog', { name: '任务详情' });
  expect(messageInput(dialog).value).toBe(originalDraft);
  sealed = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
  expect(messageInput(dialog).value).toBe(originalDraft);
  expect(messageInput(dialog).disabled).toBe(true);
  expect(within(dialog).getByText(/验收已暂停/)).toBeTruthy();
  fireEvent.submit(within(dialog).getByRole('button', { name: '发送给 Boss' }).closest('form')!);
  expect(api.messageTask).not.toHaveBeenCalled();
});
