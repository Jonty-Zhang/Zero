import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { BossProjectModal, ProjectDelivery, type BossProjectDraft } from './BossProject';
import { api } from './api';
import type { Capabilities, Task } from './types';

vi.mock('./api', () => ({ api: { tasks: vi.fn(), task: vi.fn(), sequences: vi.fn(), capabilities: vi.fn(), config: vi.fn(), prepareProject: vi.fn(), createTask: vi.fn(), connectionSetup: vi.fn() } }));
const sha = 'a'.repeat(40);
const repo = 'C:/projects/original';
const done: Task = { id: 'source', title: '上一项目', status: 'done', repoPath: repo, prompt: '旧目标不要继承', boss: { preference: '用户的团队偏好' }, delivery: { path: 'C:/old-worktree', branch: 'boss/source', resultCommit: sha } };
const caps: Capabilities = { harnesses: [{ id: 'codex', name: 'Codex', available: true }], bindings: [{ harnessId: 'codex', modelId: 'lead', available: true }], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } };
const draft = (): BossProjectDraft => ({ path: repo, prompt: '', preference: done.boss!.preference, create: false, pendingSubmission: null, continuation: { repoPath: repo, baseRef: sha } });
beforeEach(() => {
  vi.resetAllMocks(); sessionStorage.clear();
  vi.mocked(api.tasks).mockResolvedValue([done]); vi.mocked(api.task).mockResolvedValue(done);
  vi.mocked(api.sequences).mockResolvedValue([]); vi.mocked(api.capabilities).mockResolvedValue(caps);
  vi.mocked(api.config).mockResolvedValue({ allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } });
  vi.mocked(api.prepareProject).mockImplementation(async path => ({ path, repoPath: path, initialized: false }));
  vi.mocked(api.createTask).mockResolvedValue({ id: 'next', status: 'pending' });
  vi.mocked(api.connectionSetup).mockResolvedValue({ codex: { available: true, models: [{ id: 'lead', label: 'Lead' }], reasoningEfforts: [] } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function openContinuation() {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '上一项目' }));
  fireEvent.click(await screen.findByRole('button', { name: '继续这个项目' }));
  return screen.getByRole('dialog', { name: '交给 Boss' });
}
function goal() { fireEvent.change(screen.getByLabelText('你想完成什么 *'), { target: { value: '请完成下一阶段目标' } }); }
it('opens one empty-goal Boss dialog with the original project and preference, then submits the accepted commit', async () => {
  const dialog = await openContinuation();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect((within(dialog).getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe(repo);
  expect((within(dialog).getByLabelText('你想完成什么 *') as HTMLTextAreaElement).value).toBe('');
  expect((within(dialog).getByLabelText('Boss 与团队偏好（可选）') as HTMLTextAreaElement).value).toBe(done.boss!.preference);
  expect(screen.getByText('从上次验收的成果继续')).toBeTruthy();
  expect(api.prepareProject).not.toHaveBeenCalled(); expect(api.createTask).not.toHaveBeenCalled();
  goal(); fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
  await vi.waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ repoPath: repo, baseRef: sha, prompt: '请完成下一阶段目标', boss: { preference: done.boss!.preference } }));
  expect(api.prepareProject).toHaveBeenCalledWith(repo, false);
});
it.each([
  { status: 'running' }, { status: 'failed' }, { boss: undefined }, { repoPath: '' }, { repoPath: '  ' },
  ...[undefined, '', ' ', 'HEAD', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(40), ` ${sha}`].map(resultCommit => ({ delivery: { path: 'C:/old-worktree', branch: 'boss/source', resultCommit } })),
] as Partial<Task>[])('hides continuation for an ineligible result %#', override => {
  render(<ProjectDelivery task={{ ...done, ...override }} onContinue={vi.fn()} />);
  expect(screen.queryByRole('button', { name: '继续这个项目' })).toBeNull();
});
it('accepts a complete SHA-256 result', () => {
  const onContinue = vi.fn(); render(<ProjectDelivery task={{ ...done, delivery: { path: 'old', branch: 'boss/source', resultCommit: 'b'.repeat(64) } }} onContinue={onContinue} />);
  fireEvent.click(screen.getByRole('button', { name: '继续这个项目' }));
  expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ continuation: { repoPath: repo, baseRef: 'b'.repeat(64) } }));
});
it('keeps the baseline through connection settings and advanced configuration, and clears it when dismissed', async () => {
  await openContinuation(); goal();
  fireEvent.click(screen.getByRole('button', { name: '管理模型连接' }));
  await screen.findByLabelText('Codex 模型');
  fireEvent.click(screen.getByRole('button', { name: '返回项目' }));
  expect(screen.getByText('从上次验收的成果继续')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
  expect((screen.getByLabelText('基础分支 / Ref') as HTMLInputElement).value).toBe(sha);
  expect((screen.getByLabelText('基础分支 / Ref') as HTMLInputElement).readOnly).toBe(true);
  fireEvent.change(screen.getByLabelText(/仓库路径/), { target: { value: 'C:/other' } });
  expect((screen.getByLabelText('基础分支 / Ref') as HTMLInputElement).value).toBe('HEAD');
  fireEvent.change(screen.getByLabelText(/仓库路径/), { target: { value: repo } });
  expect((screen.getByLabelText('基础分支 / Ref') as HTMLInputElement).value).toBe(sha);
  fireEvent.click(screen.getByRole('button', { name: '返回 Boss' }));
  expect(screen.getByText('从上次验收的成果继续')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
  expect(screen.queryByText('从上次验收的成果继续')).toBeNull();
  expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('');
  expect(api.createTask).not.toHaveBeenCalled();
});
it('retries the exact fixed-baseline payload after an advanced round trip', async () => {
  vi.mocked(api.createTask).mockRejectedValueOnce(new Error('unknown receipt'));
  await openContinuation(); goal(); fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
  await screen.findByText('unknown receipt');
  const payload = vi.mocked(api.createTask).mock.calls[0]![0];
  expect(payload).toMatchObject({ baseRef: sha });
  fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
  fireEvent.click(screen.getByRole('button', { name: '返回 Boss' }));
  fireEvent.click(screen.getByRole('button', { name: '确认上次提交' }));
  await vi.waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.createTask).mock.calls[1]![0]).toBe(payload);
  expect(api.prepareProject).toHaveBeenCalledTimes(1);
});
it('separates pending identities by the effective baseline and drops the source commit for a different folder', async () => {
  const onAdvanced = vi.fn();
  vi.mocked(api.createTask).mockRejectedValue(new Error('unknown receipt'));
  render(<BossProjectModal capabilities={caps} capabilityError="" initialDraft={draft()} onClose={vi.fn()} onAdvanced={onAdvanced} onCreated={vi.fn()} />);
  goal(); fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
  await screen.findByText('unknown receipt');
  fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
  expect(JSON.parse(onAdvanced.mock.calls[0]![0].pendingSubmission.draftKey)).toContain(sha);
  fireEvent.change(screen.getByLabelText('项目文件夹 *'), { target: { value: 'C:/other' } });
  expect(screen.queryByText('从上次验收的成果继续')).toBeNull();
  expect(screen.queryByRole('button', { name: '确认上次提交' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
  await vi.waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.createTask).mock.calls[1]![0]).not.toHaveProperty('baseRef');
  fireEvent.change(screen.getByLabelText('项目文件夹 *'), { target: { value: repo } });
  expect(screen.getByText('从上次验收的成果继续')).toBeTruthy();
});
it('does not offer continuation from a stale detail refresh', async () => {
  vi.useFakeTimers();
  vi.mocked(api.task).mockResolvedValueOnce(done).mockRejectedValue(new Error('offline'));
  render(<App />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '上一项目' })); await act(async () => {});
  expect(screen.getByRole('button', { name: '继续这个项目' })).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
  expect(screen.getByText('刷新失败，显示上次同步内容')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '继续这个项目' })).toBeNull();
});

it('returns the latest manual goal and folder to Boss with a consistent effective baseline', async () => {
  await openContinuation(); goal();
  fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
  fireEvent.change(screen.getByLabelText(/仓库路径/), { target: { value: 'C:/other' } });
  fireEvent.change(screen.getByLabelText('任务描述 *'), { target: { value: '高级表单中的最新目标' } });
  fireEvent.click(screen.getByRole('button', { name: '返回 Boss' }));
  expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('C:/other');
  expect((screen.getByLabelText('你想完成什么 *') as HTMLTextAreaElement).value).toBe('高级表单中的最新目标');
  expect(screen.queryByText('从上次验收的成果继续')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
  await vi.waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ repoPath: 'C:/other', prompt: '高级表单中的最新目标', boss: { preference: done.boss!.preference } }));
});
it('starts a blank ordinary project after cancelling advanced continuation', async () => {
  await openContinuation(); goal();
  fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
  expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('');
  expect(screen.queryByText('从上次验收的成果继续')).toBeNull();
  fireEvent.change(screen.getByLabelText('项目文件夹 *'), { target: { value: repo } }); goal();
  fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
  await vi.waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.createTask).mock.calls[0]![0]).not.toHaveProperty('baseRef');
});
it('submits the fixed accepted commit from manual configuration', async () => {
  await openContinuation(); goal();
  fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
  fireEvent.change(screen.getByLabelText(/检查命令/), { target: { value: 'npm test' } });
  fireEvent.click(screen.getByRole('button', { name: '加入任务队列' }));
  await vi.waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.createTask).mock.calls[0]![0]).toMatchObject({ repoPath: repo, baseRef: sha, prompt: '请完成下一阶段目标' });
});
it('does not confirm a pending request for another accepted commit at the same path', () => {
  const initialDraft = draft();
  initialDraft.prompt = '请完成下一阶段目标';
  initialDraft.pendingSubmission = { draftKey: JSON.stringify([repo, false, initialDraft.prompt, initialDraft.preference, 'b'.repeat(40)]), payload: { repoPath: repo, baseRef: 'b'.repeat(40), prompt: initialDraft.prompt, boss: { preference: initialDraft.preference } } };
  render(<BossProjectModal capabilities={caps} capabilityError="" initialDraft={initialDraft} onClose={vi.fn()} onAdvanced={vi.fn()} onCreated={vi.fn()} />);
  expect(screen.queryByRole('button', { name: '确认上次提交' })).toBeNull();
  expect(screen.getByRole('button', { name: '交给 Boss' })).toBeTruthy();
});
it('uses HEAD semantics while creating a new directory and restores the source baseline when creation is disabled', async () => {
  render(<BossProjectModal capabilities={caps} capabilityError="" initialDraft={draft()} onClose={vi.fn()} onAdvanced={vi.fn()} onCreated={vi.fn()} />);
  fireEvent.click(screen.getByLabelText('这个路径还不存在，创建新文件夹'));
  expect(screen.queryByText('从上次验收的成果继续')).toBeNull();
  fireEvent.click(screen.getByLabelText('这个路径还不存在，创建新文件夹'));
  expect(screen.getByText('从上次验收的成果继续')).toBeTruthy();
  goal(); fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
  await vi.waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.createTask).mock.calls[0]![0]).toMatchObject({ baseRef: sha });
});
