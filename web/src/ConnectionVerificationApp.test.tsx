// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { api } from './api';
import type { Capabilities } from './types';
import type { VerificationJob } from './connection-verification';
import { HttpError } from './http-error';
vi.mock('./api', () => ({ api: { tasks: vi.fn(), capabilities: vi.fn(), sequences: vi.fn(), config: vi.fn(), connectionSetup: vi.fn(), verifyConnection: vi.fn(), connectionVerification: vi.fn() } }));
const ready = (available: boolean): Capabilities => ({ harnesses: [{ id: 'codex', name: 'Codex', available, cliAvailable: true }], bindings: available ? [{ harnessId: 'codex', modelId: 'lead-model', modelName: 'lead-model', available: true, reasoningEfforts: [{ id: 'high', label: 'high' }] }] : [], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } });
const running: VerificationJob = { id: 'job-1', state: 'running', modelId: 'lead-model', reasoningEffort: 'high', createdAt: '2026-10-29T00:00:00Z' };
beforeEach(() => {
  vi.resetAllMocks(); sessionStorage.clear();
  vi.mocked(api.tasks).mockResolvedValue([]); vi.mocked(api.sequences).mockResolvedValue([]);
  vi.mocked(api.config).mockResolvedValue({ allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } });
  vi.mocked(api.capabilities).mockResolvedValue(ready(false));
  vi.mocked(api.connectionSetup).mockResolvedValue({ codex: { available: true, models: [{ id: 'lead-model', label: 'Lead' }], reasoningEfforts: ['low', 'high'] } });
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.useRealTimers(); });
async function open() {
  fireEvent.click(await screen.findByRole('button', { name: '管理 Agent 连接' }));
  const dialog = screen.getByRole('dialog', { name: 'Agent 连接' });
  await vi.waitFor(() => expect((within(dialog).getByLabelText('Codex 模型') as HTMLInputElement).value).toBe('lead-model'));
  return dialog;
}
function close(dialog: HTMLElement) { fireEvent.click(within(dialog).getByRole('button', { name: '关闭 Agent 连接' })); }
for (const status of [400, 409]) it(`lets the user correct a definitively rejected ${status} model without retrying the rejected payload`, async () => {
  vi.mocked(api.verifyConnection).mockRejectedValueOnce(new HttpError('模型身份不唯一', status, true)).mockResolvedValue({ ...running, modelId: 'correct-model', state: 'succeeded' });
  render(<App />); const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '验证并接通' }));
  await within(dialog).findByText('模型身份不唯一');
  const input = within(dialog).getByLabelText('Codex 模型') as HTMLInputElement;
  expect(input.disabled).toBe(false); expect(within(dialog).queryByRole('button', { name: '重试原请求' })).toBeNull();
  fireEvent.change(input, { target: { value: 'correct-model' } });
  expect(api.verifyConnection).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole('button', { name: '验证并接通' }));
  await within(dialog).findByText(/correct-model 已通过验证/);
  expect(vi.mocked(api.verifyConnection).mock.calls[1]?.[0]).toBe('correct-model');
  expect(vi.mocked(api.verifyConnection).mock.calls[1]?.[2]).not.toBe(vi.mocked(api.verifyConnection).mock.calls[0]?.[2]);
});
it('only verifies on an explicit click, refreshes capabilities and enables the real Boss submission', async () => {
  vi.mocked(api.verifyConnection).mockImplementation(async () => { vi.mocked(api.capabilities).mockResolvedValue(ready(true)); return { ...running, state: 'succeeded' }; });
  render(<App />);
  const dialog = await open();
  expect(api.verifyConnection).not.toHaveBeenCalled();
  expect(within(dialog).getByText(/真实模型验证并使用额度/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: '验证并接通' }));
  await within(dialog).findByText(/lead-model 已通过验证/);
  await vi.waitFor(() => expect(api.capabilities).toHaveBeenCalledTimes(2));
  close(dialog);
  fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
  const project = screen.getByRole('dialog', { name: '交给 Boss' });
  fireEvent.change(within(project).getByLabelText('项目文件夹 *'), { target: { value: 'C:\\projects\\example' } });
  fireEvent.change(within(project).getByLabelText('你想完成什么 *'), { target: { value: 'Build the requested tool' } });
  expect((within(project).getByRole('button', { name: '交给 Boss' }) as HTMLButtonElement).disabled).toBe(false);
});
it('keeps a pending request across dialog teardown and settings navigation without a second POST', async () => {
  let finish!: (job: VerificationJob) => void;
  vi.mocked(api.verifyConnection).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<App />); let dialog = await open();
  const button = within(dialog).getByRole('button', { name: '验证并接通' });
  fireEvent.click(button); fireEvent.click(button);
  expect(api.verifyConnection).toHaveBeenCalledTimes(1);
  close(dialog);
  fireEvent.click(screen.getByRole('button', { name: '路由设置' }));
  await screen.findByText('Boss 与团队偏好'); dialog = await open();
  expect((within(dialog).getByLabelText('Codex 模型') as HTMLInputElement).disabled).toBe(true);
  await act(async () => { finish({ ...running, state: 'failed', error: '模型无法使用' }); });
  await within(dialog).findByText('模型无法使用');
  expect(api.verifyConnection).toHaveBeenCalledTimes(1);
});
it('retains the original key after an unknown response', async () => {
  vi.mocked(api.verifyConnection).mockRejectedValueOnce(new Error('网络断开')).mockResolvedValue({ ...running, state: 'failed', error: '请先登录 Codex' });
  render(<App />); const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '验证并接通' }));
  await within(dialog).findByText('网络断开');
  fireEvent.click(within(dialog).getByRole('button', { name: '重试原请求' }));
  await within(dialog).findByText('请先登录 Codex');
  expect(vi.mocked(api.verifyConnection).mock.calls[1]).toEqual(vi.mocked(api.verifyConnection).mock.calls[0]);
});

it('accepts a canonical model only when the backend binds the requested alias to its job', async () => {
  vi.mocked(api.verifyConnection).mockResolvedValue({ ...running, modelId: 'canonical-lead', requestedModelIds: ['lead-model'], state: 'succeeded' });
  render(<App />); const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '验证并接通' }));
  await within(dialog).findByText(/canonical-lead 已通过验证/);
  expect(api.verifyConnection).toHaveBeenCalledTimes(1);
});

it('shows an unavailable runtime without issuing model calls', async () => {
  vi.mocked(api.connectionSetup).mockResolvedValue({ codex: { available: false, reason: '请先安装 Codex 运行组件', models: [{ id: 'lead-model', label: 'Lead' }], reasoningEfforts: ['high'] } });
  render(<App />); const dialog = await open();
  expect(within(dialog).getByText('请先安装 Codex 运行组件')).toBeTruthy();
  expect((within(dialog).getByRole('button', { name: '验证并接通' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.verifyConnection).not.toHaveBeenCalled();
});

it('explains interrupted calls and requires a new explicit action to retry', async () => {
  vi.mocked(api.verifyConnection).mockResolvedValueOnce({ ...running, state: 'interrupted' }).mockResolvedValue({ ...running, state: 'failed', error: '验证未通过' });
  render(<App />); const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '验证并接通' }));
  await within(dialog).findByText(/模型可能已执行/);
  expect(api.verifyConnection).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole('button', { name: '重新验证并接通' }));
  await within(dialog).findByText('验证未通过');
  expect(vi.mocked(api.verifyConnection).mock.calls[1]?.[2]).not.toBe(vi.mocked(api.verifyConnection).mock.calls[0]?.[2]);
});

it('recovers a lost result by GET when reopened and refreshes Boss readiness without another POST', async () => {
  vi.mocked(api.verifyConnection).mockResolvedValue(running);
  vi.mocked(api.connectionVerification).mockRejectedValueOnce(new Error('读取结果时断线')).mockImplementation(async () => {
    vi.mocked(api.capabilities).mockResolvedValue(ready(true)); return { ...running, state: 'succeeded' };
  });
  render(<App />); let dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: '验证并接通' }));
  await within(dialog).findByText('读取结果时断线', {}, { timeout: 2500 });
  close(dialog); dialog = await open();
  await within(dialog).findByText(/lead-model 已通过验证/);
  expect(api.verifyConnection).toHaveBeenCalledTimes(1);
  expect(api.connectionVerification).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(api.capabilities).toHaveBeenCalledTimes(2));
});
