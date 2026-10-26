import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { BossProgress, BossProjectModal, ProjectDelivery } from './BossProject';
import { api } from './api';
import type { Capabilities, Task } from './types';

vi.mock('./api', () => ({ api: { tasks: vi.fn(), task: vi.fn(), capabilities: vi.fn(), sequences: vi.fn(), sequence: vi.fn(), config: vi.fn(), saveConfig: vi.fn(), folders: vi.fn(), prepareProject: vi.fn(), createTask: vi.fn(), messageTask: vi.fn() } }));
const capabilities: Capabilities = { harnesses: [{ id: 'codex', name: 'Codex', available: true }], bindings: [{ harnessId: 'codex', modelId: 'verified-model', available: true }], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } };
const task: Task = { id: 'boss-task', status: 'running', prompt: '完成项目目标', boss: { preference: 'Codex gpt6.1sol high，简单部分交给 DeepSeek' } };
const config = { allocator: { kind: 'codex' as const, modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } };
function modal(props: Partial<Parameters<typeof BossProjectModal>[0]> = {}) {
  return render(<BossProjectModal capabilities={capabilities} capabilityError="" onClose={vi.fn()} onAdvanced={vi.fn()} onCreated={vi.fn()} {...props} />);
}
function fillGoal() {
  fireEvent.change(screen.getByLabelText('项目文件夹 *'), { target: { value: 'C:/projects/plain' } });
  fireEvent.change(screen.getByLabelText('你想完成什么 *'), { target: { value: '设计并实现这个项目，自己验证' } });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.tasks).mockResolvedValue([]); vi.mocked(api.sequences).mockResolvedValue([]); vi.mocked(api.capabilities).mockResolvedValue(capabilities);
  vi.mocked(api.config).mockResolvedValue(config); vi.mocked(api.saveConfig).mockImplementation(async value => value);
  vi.mocked(api.task).mockResolvedValue(task); vi.mocked(api.prepareProject).mockResolvedValue({ path: 'C:/projects/plain', repoPath: 'C:/projects/plain', initialized: true });
  vi.mocked(api.createTask).mockResolvedValue(task); vi.mocked(api.messageTask).mockResolvedValue({ accepted: true });
});
afterEach(cleanup);

describe('Boss project entry', () => {
  it('defaults to the goal and free-form Boss preference without manual execution gates', async () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
    const dialog = screen.getByRole('dialog', { name: '交给 Boss' });
    expect(within(dialog).getByLabelText('项目文件夹 *')).toBeTruthy();
    expect(within(dialog).getByLabelText('你想完成什么 *')).toBeTruthy();
    expect(within(dialog).getByLabelText('Boss 与团队偏好（可选）')).toBeTruthy();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByLabelText(/检查命令|最大返工|基础分支|执行阶段/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '高级模式：手动执行任务' }));
    expect(screen.getByRole('dialog', { name: '提交执行任务' })).toBeTruthy();
  });
  it('prepares a plain folder and submits the original natural preference with no invented checks or route', async () => {
    const onCreated = vi.fn(); modal({ onCreated }); fillGoal();
    fireEvent.change(screen.getByLabelText('Boss 与团队偏好（可选）'), { target: { value: '  Codex gpt6.1sol high，复杂问题讨论，其他交给 DSH  ' } });
    fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(task));
    expect(api.prepareProject).toHaveBeenCalledWith('C:/projects/plain', false);
    expect(api.createTask).toHaveBeenCalledWith({ repoPath: 'C:/projects/plain', prompt: '设计并实现这个项目，自己验证', boss: { preference: 'Codex gpt6.1sol high，复杂问题讨论，其他交给 DSH' } });
  });
  it('browses the local server folder and selects a new child without creating it until submission', async () => {
    vi.mocked(api.folders).mockResolvedValue({ path: 'C:\\projects', parent: 'C:\\', folders: [{ name: 'existing', path: 'C:\\projects\\existing' }] });
    modal(); fireEvent.click(screen.getByRole('button', { name: '浏览文件夹' }));
    await screen.findByRole('button', { name: 'existing' });
    fireEvent.change(screen.getByLabelText('新文件夹名称'), { target: { value: 'new-project' } });
    fireEvent.click(screen.getByRole('button', { name: '使用新文件夹' }));
    expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('C:\\projects\\new-project');
    expect((screen.getByLabelText('这个路径还不存在，创建新文件夹') as HTMLInputElement).checked).toBe(true);
    expect(api.prepareProject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('你想完成什么 *'), { target: { value: '从零创建一个工具' } });
    fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
    await vi.waitFor(() => expect(api.prepareProject).toHaveBeenCalledWith('C:\\projects\\new-project', true));
  });
  it('keeps the draft and shows the real folder error without submitting a task', async () => {
    vi.mocked(api.prepareProject).mockRejectedValue(new Error('路径不可访问，请选择有权限的项目目录'));
    modal(); fillGoal(); fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('路径不可访问'));
    expect(api.createTask).not.toHaveBeenCalled();
    expect((screen.getByLabelText('你想完成什么 *') as HTMLTextAreaElement).value).toBe('设计并实现这个项目，自己验证');
  });
  it('locks submission and close controls across folder preparation and task creation', async () => {
    let resolvePrepare!: (value: Awaited<ReturnType<typeof api.prepareProject>>) => void;
    vi.mocked(api.prepareProject).mockImplementation(() => new Promise(resolve => { resolvePrepare = resolve; }));
    vi.mocked(api.createTask).mockImplementation(() => new Promise(() => {}));
    const onClose = vi.fn(); modal({ onClose }); fillGoal();
    const dialog = screen.getByRole('dialog'); const form = dialog.querySelector('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(api.prepareProject).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document.body, { key: 'Escape' }); fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).not.toHaveBeenCalled(); expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolvePrepare({ path: 'C:/projects/plain', repoPath: 'C:/projects/plain', initialized: true }));
    expect(api.createTask).toHaveBeenCalledTimes(1);
    fireEvent.submit(form); expect(api.createTask).toHaveBeenCalledTimes(1);
  });
  it('aborts stale folder navigation and ignores a late result after the browser closes', async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof api.folders>>) => void;
    vi.mocked(api.folders).mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    modal(); fireEvent.click(screen.getByRole('button', { name: '浏览文件夹' }));
    const firstSignal = vi.mocked(api.folders).mock.calls[0]![1]!.signal!;
    fireEvent.click(screen.getByRole('button', { name: '关闭文件夹浏览' })); expect(firstSignal.aborted).toBe(true);
    await act(async () => resolveFirst({ path: 'C:/stale', parent: null, folders: [] }));
    expect(screen.queryByLabelText('本机文件夹浏览')).toBeNull();
    expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('');
  });
});

describe('Boss settings and project conversation', () => {
  it('shows and copies the authoritative result folder and commit instead of the original project', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ProjectDelivery task={{ ...task, status: 'done', repoPath: 'C:/original-project', delivery: { path: 'C:/zero/data/worktrees/boss-task', branch: 'zero/boss-task', resultCommit: 'a'.repeat(40) } }} />);
    const panel = screen.getByRole('region', { name: '项目成果' });
    expect(within(panel).getByText('C:/zero/data/worktrees/boss-task')).toBeTruthy();
    expect(within(panel).getByText('a'.repeat(40))).toBeTruthy();
    expect(within(panel).queryByText('C:/original-project')).toBeNull();
    expect(within(panel).getByText(/原选文件夹未自动回写/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: '复制路径' }));
    await within(panel).findByRole('button', { name: '已复制路径' });
    expect(writeText).toHaveBeenCalledWith('C:/zero/data/worktrees/boss-task');
  });
  it('does not mistake a live worktree or missing historical delivery data for a completed result', () => {
    const view = render(<ProjectDelivery task={{ ...task, delivery: { path: 'C:/worktree', branch: 'zero/task' } }} />);
    expect(screen.getByRole('region', { name: '任务工作目录' })).toBeTruthy();
    expect(screen.getByText(/任务尚未验收完成/)).toBeTruthy();
    expect(screen.queryByText('项目成果已准备好')).toBeNull();
    view.rerender(<ProjectDelivery task={{ ...task, status: 'done', repoPath: 'C:/must-not-be-output' }} />);
    expect(screen.queryByText('C:/must-not-be-output')).toBeNull();
    expect(screen.getByText(/服务端未提供可确认的成果目录/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '复制路径' })).toBeNull();
  });
  it('keeps the actual result path selectable when clipboard access is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) } });
    render(<ProjectDelivery task={{ ...task, status: 'done', delivery: { path: 'C:/actual-output', branch: 'zero/task' } }} />);
    fireEvent.click(screen.getByRole('button', { name: '复制路径' }));
    expect((await screen.findByRole('alert')).textContent).toContain('手动复制');
    expect(screen.getByText('C:/actual-output')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '已复制路径' })).toBeNull();
  });
  it('saves the free-form default preference even when there are no dropdown model choices', async () => {
    vi.mocked(api.capabilities).mockResolvedValue({ ...capabilities, bindings: [] });
    render(<App />); fireEvent.click(screen.getByRole('button', { name: '路由设置' }));
    fireEvent.change(await screen.findByLabelText('默认 Boss 偏好'), { target: { value: 'gpt6.1sol high 负责设计，便宜模型负责具体操作' } });
    expect((screen.getByLabelText('默认模型').closest('details') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText('尚无可用的模型绑定')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await vi.waitFor(() => expect(api.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ boss: { preference: 'gpt6.1sol high 负责设计，便宜模型负责具体操作' } })));
  });
  it('shows the actual plan, consultation identities and messages then sends a supplementary question', async () => {
    const onMessage = vi.fn();
    render(<BossProgress onMessage={onMessage} task={{ ...task, bossPlan: { summary: '先讨论接口，再实现和验收', acceptanceCriteria: ['接口和界面均可使用'], stages: [{ objective: '实现接口', harness: 'dsh', model: 'deepseek' }], checks: [{ id: 'unit', argv: ['npm', 'test'] }], maxRevisions: 2 }, bossMessages: [{ id: 'consult-1', role: 'consultant', content: '建议优先验证恢复路径', at: '2026-10-25T10:00:00Z', harness: 'dsh', model: 'deepseek' }] }} />);
    expect(screen.getByText('先讨论接口，再实现和验收')).toBeTruthy();
    expect(screen.getByText('建议优先验证恢复路径')).toBeTruthy(); expect(screen.getAllByText('dsh · deepseek').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('给 Boss 补充信息或提问'), { target: { value: '请额外检查取消和恢复' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给 Boss' }));
    await screen.findByRole('status');
    expect(api.messageTask).toHaveBeenCalledWith(task.id, '请额外检查取消和恢复'); expect(onMessage).toHaveBeenCalledTimes(1);
  });
  it.each(['done', 'reviewing'] as const)('disables new messages for a %s task and directs users to a follow-up task', async status => {
    render(<BossProgress onMessage={vi.fn()} task={{ ...task, status }} />);
    expect(screen.getByText(/新建后续任务/)).toBeTruthy();
    expect((screen.getByLabelText('给 Boss 补充信息或提问') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '发送给 Boss' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('button', { name: '发送给 Boss' }).closest('form')!);
    expect(api.messageTask).not.toHaveBeenCalled();
    expect(api.createTask).not.toHaveBeenCalled();
  });
  it('retains the message on send failure and prevents concurrent duplicate sends', async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(api.messageTask).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<BossProgress onMessage={vi.fn()} task={task} />);
    fireEvent.change(screen.getByLabelText('给 Boss 补充信息或提问'), { target: { value: '需要保留这条消息' } });
    const form = screen.getByRole('button', { name: '发送给 Boss' }).closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form); expect(api.messageTask).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('消息服务暂不可用')));
    expect(screen.getByRole('alert').textContent).toBe('消息服务暂不可用');
    expect((screen.getByLabelText('给 Boss 补充信息或提问') as HTMLTextAreaElement).value).toBe('需要保留这条消息');
  });
});
