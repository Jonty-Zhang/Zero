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

describe('persisted Boss replies', () => {
  const user = { id: 'question-1', role: 'user' as const, content: '为什么选择这个方案？', at: '2026-10-29T10:00:00Z' };
  const reply = { id: 'answer-1', role: 'boss' as const, content: '它减少了组件间的耦合；检查仍有两项未通过。', at: '2026-10-29T10:01:00Z', inReplyTo: user.id, reviewPackageId: 'package-1', reviewAttemptId: 'attempt-1' };
  it('shows the exact question and answered receipt only for a complete persisted reply', () => {
    render(<BossProgress task={{ ...task, bossMessages: [user, reply] }} onMessage={vi.fn()} />);
    const answer = screen.getByText(reply.content).closest('article')!;
    expect(within(answer).getByText('回复')).toBeTruthy();
    expect(within(answer).getByLabelText('回复的原消息').textContent).toContain(user.content);
    const original = screen.getAllByText(user.content).find(item => !answer.contains(item))!.closest('article')!;
    expect(within(original).getByText('已答复')).toBeTruthy();
    expect(screen.queryByText('已实现')).toBeNull(); expect(screen.queryByText('已验收')).toBeNull();
    expect(screen.queryByText('package-1')).toBeNull(); expect(screen.queryByText('attempt-1')).toBeNull();
    expect(screen.getByText(/回答在验收时产生/)).toBeTruthy();
    expect(api.messageTask).not.toHaveBeenCalled();
  });
  it.each([
    ['historical summary', { inReplyTo: undefined, reviewPackageId: undefined, reviewAttemptId: undefined }],
    ['missing package', { reviewPackageId: undefined }], ['missing attempt', { reviewAttemptId: undefined }],
    ['empty package', { reviewPackageId: '  ' }], ['foreign message', { inReplyTo: 'other-task-question' }],
    ['consultant target', { inReplyTo: 'consultant-1' }], ['not Boss', { role: 'consultant' as const }], ['empty answer', { content: '  ' }],
  ])('does not infer a reply from %s', (_name, override) => {
    render(<BossProgress task={{ ...task, bossMessages: [user, { ...user, id: 'consultant-1', role: 'consultant' }, { ...reply, ...override }] }} onMessage={vi.fn()} />);
    expect(screen.queryByText('已答复')).toBeNull(); expect(screen.queryByText('回复')).toBeNull();
    expect(screen.queryByLabelText('回复的原消息')).toBeNull();
  });
  it('preserves exact context across refresh order, waits for the original page and never carries it into another task', () => {
    const view = render(<BossProgress task={{ ...task, bossMessages: [reply] }} onMessage={vi.fn()} />);
    expect(screen.queryByText('已答复')).toBeNull();
    view.rerender(<BossProgress task={{ ...task, bossMessages: [reply, user] }} onMessage={vi.fn()} />);
    expect(screen.getByLabelText('回复的原消息').textContent).toContain(user.content);
    view.rerender(<BossProgress task={{ ...task, bossMessages: [user, { ...user, id: 'later-question', content: '另一个问题' }, reply] }} onMessage={vi.fn()} />);
    expect(screen.getByLabelText('回复的原消息').textContent).toContain(user.content);
    expect(screen.getByText('另一个问题').closest('article')!.textContent).not.toContain('已答复');
    view.rerender(<BossProgress task={{ ...task, id: 'another-task', bossMessages: [reply] }} onMessage={vi.fn()} />);
    expect(screen.queryByLabelText('回复的原消息')).toBeNull(); expect(screen.queryByText(user.content)).toBeNull();
  });
});

describe('recorded project lead', () => {
  it('shows the saved Boss identity separately from the executor and preference', () => {
    const bossPlan = { summary: '已保存的项目方案', acceptanceCriteria: [], stages: [], checks: [], maxRevisions: 2, boss: { harness: 'codex', model: 'actual-lead', reasoningEffort: 'high' } };
    const { rerender } = render(<BossProgress task={{ ...task, route: { harnessId: 'dsh', modelId: 'worker' }, bossPlan }} onMessage={vi.fn()} />);
    expect(screen.getByLabelText('项目负责人').textContent).toBe('Boss · codex · actual-lead · high');
    rerender(<BossProgress task={{ ...task, bossPlan: { ...bossPlan, boss: { harness: 'codex', model: 'updated-lead' } } }} onMessage={vi.fn()} />);
    expect(screen.getByLabelText('项目负责人').textContent).toBe('Boss · codex · updated-lead');
  });
  it('does not invent a lead for a historical plan without a saved Boss', () => {
    render(<BossProgress task={{ ...task, route: { harnessId: 'dsh', modelId: 'worker' }, bossPlan: { summary: '旧方案', acceptanceCriteria: [], stages: [], checks: [], maxRevisions: 2 } }} onMessage={vi.fn()} />);
    expect(screen.queryByLabelText('项目负责人')).toBeNull();
    expect(screen.getByText(task.boss!.preference)).toBeTruthy();
  });
});

describe('Boss draft handoff', () => {
  const original = { path: 'C:/projects/not-created-yet', prompt: '设计跨 Agent 项目并完成可靠验收', preference: 'Codex gpt6.1sol high；简单实现交给 DSH' };
  async function openDraft() {
    render(<App />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
    fireEvent.change(screen.getByLabelText('项目文件夹 *'), { target: { value: original.path } });
    fireEvent.change(screen.getByLabelText('你想完成什么 *'), { target: { value: original.prompt } });
    fireEvent.change(screen.getByLabelText('Boss 与团队偏好（可选）'), { target: { value: original.preference } });
    fireEvent.click(screen.getByLabelText('这个路径还不存在，创建新文件夹'));
  }
  function reopenBoss() {
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
    return screen.getByRole('dialog', { name: '交给 Boss' });
  }
  function expectOriginalDraft() {
    expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe(original.path);
    expect((screen.getByLabelText('你想完成什么 *') as HTMLTextAreaElement).value).toBe(original.prompt);
    expect((screen.getByLabelText('Boss 与团队偏好（可选）') as HTMLTextAreaElement).value).toBe(original.preference);
    expect((screen.getByLabelText('这个路径还不存在，创建新文件夹') as HTMLInputElement).checked).toBe(true);
  }
  function expectBlankDraft() {
    expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('你想完成什么 *') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText('Boss 与团队偏好（可选）') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText('这个路径还不存在，创建新文件夹') as HTMLInputElement).checked).toBe(false);
  }
  it('carries the folder and goal into manual configuration without preparing, creating or inferring a route', async () => {
    await openDraft();
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    const dialog = screen.getByRole('dialog', { name: '提交执行任务' });
    expect((within(dialog).getByLabelText(/仓库路径/) as HTMLInputElement).value).toBe(original.path);
    expect((within(dialog).getByLabelText('任务描述 *') as HTMLTextAreaElement).value).toBe(original.prompt);
    expect((within(dialog).getByLabelText('基础分支 / Ref') as HTMLInputElement).value).toBe('HEAD');
    expect((within(dialog).getByLabelText(/检查命令/) as HTMLTextAreaElement).value).toBe('');
    expect(within(dialog).getAllByRole('combobox').map(select => (select as HTMLSelectElement).value)).toEqual(['', '', '']);
    expect(api.prepareProject).not.toHaveBeenCalled(); expect(api.createTask).not.toHaveBeenCalled(); expect(api.folders).not.toHaveBeenCalled();
  });
  it('restores the entire original Boss draft after cancelling manual edits', async () => {
    await openDraft();
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    fireEvent.change(screen.getByLabelText(/仓库路径/), { target: { value: 'C:/discarded-manual-folder' } });
    fireEvent.change(screen.getByLabelText('任务描述 *'), { target: { value: '这些手动修改被取消' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    reopenBoss(); expectOriginalDraft();
    expect(api.prepareProject).not.toHaveBeenCalled(); expect(api.createTask).not.toHaveBeenCalled();
  });
  it.each(['取消', '关闭对话框', 'Escape'])('clears a restored Boss draft when explicitly dismissed with %s', async action => {
    await openDraft();
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    reopenBoss(); expectOriginalDraft();
    if (action === 'Escape') fireEvent.keyDown(screen.getByLabelText('项目文件夹 *'), { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: action }));
    reopenBoss(); expectBlankDraft();
  });
  it.each(['Boss', 'manual'])('clears the cached draft after a successful %s submission', async mode => {
    await openDraft();
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    if (mode === 'Boss') {
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      reopenBoss(); expectOriginalDraft();
      fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
    } else {
      expect((screen.getByLabelText('任务描述 *') as HTMLTextAreaElement).value).toBe(original.prompt);
      fireEvent.change(screen.getByLabelText(/检查命令/), { target: { value: 'npm test' } });
      fireEvent.click(screen.getByRole('button', { name: '加入任务队列' }));
    }
    const detail = await screen.findByRole('dialog', { name: '任务详情' });
    fireEvent.click(within(detail).getByRole('button', { name: '关闭详情' }));
    reopenBoss(); expectBlankDraft();
    expect(api.createTask).toHaveBeenCalledTimes(1);
    if (mode === 'manual') {
      expect(api.prepareProject).not.toHaveBeenCalled();
      expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ repoPath: original.path, prompt: original.prompt, execution: { harnessId: null, modelId: null, reasoningEffort: null } }));
      expect(vi.mocked(api.createTask).mock.calls[0]![0]).not.toHaveProperty('boss');
    }
  });
  it('keeps a prepared uncertain Boss request unchanged across a manual round trip', async () => {
    vi.mocked(api.prepareProject).mockResolvedValue({ path: 'C:/canonical-project', repoPath: 'C:/canonical-project', initialized: true });
    vi.mocked(api.createTask).mockRejectedValueOnce(new Error('Response uncertain')).mockResolvedValueOnce(task);
    await openDraft();
    fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
    await screen.findByText('Response uncertain');
    const firstPayload = vi.mocked(api.createTask).mock.calls[0]![0];
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    reopenBoss(); expectOriginalDraft();
    expect(screen.getByText('上次提交结果未确认。重试不会重复创建任务。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认上次提交' }));
    await screen.findByRole('dialog', { name: '任务详情' });
    expect(api.prepareProject).toHaveBeenCalledTimes(1);
    expect(api.prepareProject).toHaveBeenCalledWith(original.path, true);
    expect(api.createTask).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.createTask).mock.calls[1]![0]).toEqual(firstPayload);
    expect(firstPayload).toEqual({ repoPath: 'C:/canonical-project', prompt: original.prompt, boss: { preference: original.preference } });
  });
  it('restores an uncertain snapshot without preparation and allows confirmation even when capabilities disappear', async () => {
    const onAdvanced = vi.fn();
    vi.mocked(api.createTask).mockRejectedValueOnce(new Error('Response uncertain'));
    const view = modal({ onAdvanced }); fillGoal();
    fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
    await screen.findByText('Response uncertain');
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    expect(onAdvanced).toHaveBeenCalledWith({ path: 'C:/projects/plain', prompt: '设计并实现这个项目，自己验证', preference: '', create: false, pendingSubmission: { draftKey: JSON.stringify(['C:/projects/plain', false, '设计并实现这个项目，自己验证', '', null]), payload: { repoPath: 'C:/projects/plain', prompt: '设计并实现这个项目，自己验证', boss: { preference: '' } } } });
    const draft = onAdvanced.mock.calls[0]![0];
    const onCreated = vi.fn();
    view.unmount();
    modal({ initialDraft: draft, capabilities: null, capabilityError: 'Capability connection unavailable', onCreated });
    expect(api.prepareProject).toHaveBeenCalledTimes(1); expect(api.createTask).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: '确认上次提交' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确认上次提交' }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(task));
    expect(api.prepareProject).toHaveBeenCalledTimes(1); expect(api.createTask).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.createTask).mock.calls[1]![0]).toBe(draft.pendingSubmission.payload);
  });
});

describe('Boss project entry', () => {
  it('defaults to the goal and free-form Boss preference without manual execution gates', async () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
    const dialog = screen.getByRole('dialog', { name: '交给 Boss' });
    expect(within(dialog).getByLabelText('项目文件夹 *')).toBeTruthy();
    expect(within(dialog).getByLabelText('你想完成什么 *')).toBeTruthy();
    expect(within(dialog).getByLabelText('Boss 与团队偏好（可选）')).toBeTruthy();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByLabelText(/检查命令|最大返工|基础分支|执行阶段/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '手动配置' }));
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
  it.each([
    ['能力读取中', null, ''],
    ['能力读取失败', capabilities, '能力服务暂不可用'],
    ['只有执行 Agent', { ...capabilities, harnesses: [{ id: 'dsh', name: 'DSH', available: true }], bindings: [{ harnessId: 'dsh', modelId: 'worker', available: true }] }, ''],
    ['Codex CLI 没有已验证模型', { ...capabilities, bindings: [] }, ''],
    ['Codex 模型验证已失效', { ...capabilities, bindings: [{ harnessId: 'codex', modelId: 'verified-model', available: false }] }, ''],
    ['Codex Harness 不可用', { ...capabilities, harnesses: [{ id: 'codex', name: 'Codex', available: false, reason: 'Codex CLI 版本已变化' }] }, ''],
  ] as const)('keeps the Boss draft without preparing or queuing when %s', async (_label, active, error) => {
    const onCreated = vi.fn();
    modal({ capabilities: active as Capabilities | null, capabilityError: error, onCreated }); fillGoal();
    fireEvent.change(screen.getByLabelText('Boss 与团队偏好（可选）'), { target: { value: '老板模型名字可能写得不准确' } });
    expect((screen.getByRole('button', { name: '交给 Boss' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/正在确认 Codex|尚无可用的 Codex|无法读取可用模型/)).toBeTruthy();
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
    await act(async () => {});
    expect(api.prepareProject).not.toHaveBeenCalled(); expect(api.createTask).not.toHaveBeenCalled(); expect(onCreated).not.toHaveBeenCalled();
    expect((screen.getByLabelText('你想完成什么 *') as HTMLTextAreaElement).value).toBe('设计并实现这个项目，自己验证');
    expect((screen.getByLabelText('Boss 与团队偏好（可选）') as HTMLTextAreaElement).value).toBe('老板模型名字可能写得不准确');
  });
  it('unlocks the same Boss draft after a verified Codex lead becomes available', async () => {
    const props = { capabilityError: '', onClose: vi.fn(), onAdvanced: vi.fn(), onCreated: vi.fn() };
    const view = render(<BossProjectModal {...props} capabilities={null} />); fillGoal();
    fireEvent.change(screen.getByLabelText('Boss 与团队偏好（可选）'), { target: { value: '按我的偏好选择，名字不一定准确' } });
    expect((screen.getByRole('button', { name: '交给 Boss' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<BossProjectModal {...props} capabilities={capabilities} />);
    expect((screen.getByRole('button', { name: '交给 Boss' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
    await vi.waitFor(() => expect(props.onCreated).toHaveBeenCalledWith(task));
    expect(api.createTask).toHaveBeenCalledWith({ repoPath: 'C:/projects/plain', prompt: '设计并实现这个项目，自己验证', boss: { preference: '按我的偏好选择，名字不一定准确' } });
  });
  it('confirms an uncertain original submission after capabilities disappear without preparing the folder again', async () => {
    vi.mocked(api.prepareProject).mockResolvedValue({ path: 'C:/canonical-project', repoPath: 'C:/canonical-project', initialized: true });
    vi.mocked(api.createTask).mockRejectedValueOnce(new Error('Accepted response lost')).mockResolvedValueOnce(task);
    const props = { capabilityError: '', onClose: vi.fn(), onAdvanced: vi.fn(), onCreated: vi.fn() };
    const view = render(<BossProjectModal {...props} capabilities={capabilities} />); fillGoal();
    fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Accepted response lost');
    view.rerender(<BossProjectModal {...props} capabilities={null} capabilityError="能力连接已中断" />);
    const submit = screen.getByRole('dialog').querySelector('button[type=submit]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.submit(submit.closest('form')!);
    await vi.waitFor(() => expect(props.onCreated).toHaveBeenCalledWith(task));
    expect(api.prepareProject).toHaveBeenCalledTimes(1);
    expect(api.createTask).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.createTask).mock.calls[1]![0]).toEqual(vi.mocked(api.createTask).mock.calls[0]![0]);
    expect(api.createTask).toHaveBeenLastCalledWith({ repoPath: 'C:/canonical-project', prompt: '设计并实现这个项目，自己验证', boss: { preference: '' } });
  });
  it.each(['path', 'prompt', 'preference', 'create'] as const)('does not treat a changed %s as the original unconfirmed submission', async field => {
    vi.mocked(api.createTask).mockRejectedValueOnce(new Error('Response uncertain'));
    const props = { capabilityError: '', onClose: vi.fn(), onAdvanced: vi.fn(), onCreated: vi.fn() };
    const view = render(<BossProjectModal {...props} capabilities={capabilities} />); fillGoal();
    fireEvent.click(screen.getByRole('button', { name: '交给 Boss' })); await screen.findByRole('alert');
    view.rerender(<BossProjectModal {...props} capabilities={null} />);
    if (field === 'create') fireEvent.click(screen.getByLabelText('这个路径还不存在，创建新文件夹'));
    else fireEvent.change(screen.getByLabelText(field === 'path' ? '项目文件夹 *' : field === 'prompt' ? '你想完成什么 *' : 'Boss 与团队偏好（可选）'), { target: { value: 'Changed draft' } });
    const submit = screen.getByRole('dialog').querySelector('button[type=submit]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true); fireEvent.submit(submit.closest('form')!);
    await act(async () => {});
    expect(api.prepareProject).toHaveBeenCalledTimes(1); expect(api.createTask).toHaveBeenCalledTimes(1);
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
  it.each(['文件夹不存在或没有访问权限', 'Failed to fetch'])('does not offer a stale folder after navigation fails: %s', async message => {
    vi.mocked(api.folders).mockResolvedValueOnce({ path: 'C:\\previous-folder', parent: 'C:\\', folders: [{ name: 'old-child', path: 'C:\\previous-folder\\old-child' }] })
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce({ path: 'C:\\intended-folder', parent: 'C:\\', folders: [] });
    modal(); fillGoal(); fireEvent.click(screen.getByRole('button', { name: '浏览文件夹' }));
    await screen.findByRole('button', { name: 'old-child' });
    fireEvent.change(screen.getByLabelText('新文件夹名称'), { target: { value: 'old-draft' } });
    fireEvent.change(screen.getByLabelText('浏览路径'), { target: { value: 'C:\\intended-folder' } });
    fireEvent.click(screen.getByRole('button', { name: '打开路径' }));
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(screen.queryByRole('button', { name: '选择此文件夹' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'old-child' })).toBeNull();
    expect(screen.queryByLabelText('新文件夹名称')).toBeNull();
    expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('C:/projects/plain');
    expect((screen.getByLabelText('你想完成什么 *') as HTMLTextAreaElement).value).toBe('设计并实现这个项目，自己验证');
    expect(api.prepareProject).not.toHaveBeenCalled(); expect(api.createTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '打开路径' }));
    const choose = await screen.findByRole('button', { name: '选择此文件夹' });
    expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(choose);
    expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('C:\\intended-folder');
    expect(api.prepareProject).not.toHaveBeenCalled(); expect(api.createTask).not.toHaveBeenCalled();
  });
  it('retains a failed child navigation target so retry opens that child rather than its previous parent', async () => {
    vi.mocked(api.folders).mockResolvedValueOnce({ path: 'C:\\parent', parent: 'C:\\', folders: [{ name: 'requested-child', path: 'C:\\parent\\requested-child' }] })
      .mockRejectedValueOnce(new Error('暂时无法读取子文件夹'))
      .mockResolvedValueOnce({ path: 'C:\\parent\\requested-child', parent: 'C:\\parent', folders: [] });
    modal(); fireEvent.click(screen.getByRole('button', { name: '浏览文件夹' }));
    fireEvent.click(await screen.findByRole('button', { name: 'requested-child' }));
    expect((await screen.findByRole('alert')).textContent).toContain('暂时无法读取子文件夹');
    expect((screen.getByLabelText('浏览路径') as HTMLInputElement).value).toBe('C:\\parent\\requested-child');
    expect(screen.queryByRole('button', { name: '选择此文件夹' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开路径' }));
    await screen.findByRole('button', { name: '选择此文件夹' });
    expect(api.folders).toHaveBeenLastCalledWith('C:\\parent\\requested-child', { signal: expect.any(AbortSignal) });
    expect(api.prepareProject).not.toHaveBeenCalled(); expect(api.createTask).not.toHaveBeenCalled();
  });
  it('Enter on a new folder name selects that folder without submitting the previous project', async () => {
    vi.mocked(api.folders).mockResolvedValue({ path: 'C:\\projects', parent: 'C:\\', folders: [] });
    modal(); fillGoal(); fireEvent.click(screen.getByRole('button', { name: '浏览文件夹' }));
    const input = await screen.findByLabelText('新文件夹名称');
    fireEvent.change(input, { target: { value: 'chosen-new-project' } });
    expect(fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })).toBe(false);
    expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('C:\\projects\\chosen-new-project');
    expect((screen.getByLabelText('这个路径还不存在，创建新文件夹') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('本机文件夹浏览')).toBeNull();
    expect(api.prepareProject).not.toHaveBeenCalled(); expect(api.createTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
    await vi.waitFor(() => expect(api.prepareProject).toHaveBeenCalledWith('C:\\projects\\chosen-new-project', true));
  });
  it('keeps task submission closed while choosing a folder, including invalid names and implicit submits', async () => {
    vi.mocked(api.folders).mockResolvedValue({ path: 'C:\\projects', parent: 'C:\\', folders: [] });
    modal(); fillGoal(); fireEvent.click(screen.getByRole('button', { name: '浏览文件夹' }));
    const input = await screen.findByLabelText('新文件夹名称');
    expect((screen.getByRole('button', { name: '交给 Boss' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '../wrong-folder' } });
    expect(fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })).toBe(false);
    expect(screen.getByRole('alert').textContent).toMatch(/不能包含路径分隔符/);
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
    expect(api.prepareProject).not.toHaveBeenCalled(); expect(api.createTask).not.toHaveBeenCalled();
    expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('C:/projects/plain');
    fireEvent.click(screen.getByRole('button', { name: '关闭文件夹浏览' }));
    expect((screen.getByRole('button', { name: '交给 Boss' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it.each([
    ['新文件夹名称', { isComposing: true, keyCode: 13 }],
    ['新文件夹名称', { isComposing: false, keyCode: 229 }],
    ['浏览路径', { isComposing: true, keyCode: 13 }],
    ['浏览路径', { isComposing: false, keyCode: 229 }],
  ] as const)('preserves IME confirmation in %s (%j) before accepting a separate Enter', async (label, keyboard) => {
    vi.mocked(api.folders).mockResolvedValue({ path: 'C:\\projects', parent: 'C:\\', folders: [] });
    modal(); fillGoal(); fireEvent.click(screen.getByRole('button', { name: '浏览文件夹' }));
    await screen.findByLabelText('新文件夹名称');
    const input = screen.getByLabelText(label);
    const value = label === '新文件夹名称' ? '中文项目' : 'C:\\projects\\中文项目';
    fireEvent.compositionStart(input); fireEvent.change(input, { target: { value } });
    expect(fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', ...keyboard })).toBe(true);
    expect(screen.getByLabelText('本机文件夹浏览')).toBeTruthy();
    expect(api.folders).toHaveBeenCalledTimes(1);
    expect(api.prepareProject).not.toHaveBeenCalled(); expect(api.createTask).not.toHaveBeenCalled();
    expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('C:/projects/plain');
    fireEvent.compositionEnd(input);
    expect(fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 })).toBe(false);
    if (label === '新文件夹名称') {
      expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe('C:\\projects\\中文项目');
      expect(screen.queryByLabelText('本机文件夹浏览')).toBeNull();
    } else {
      await vi.waitFor(() => expect(api.folders).toHaveBeenCalledTimes(2));
      expect(api.folders).toHaveBeenLastCalledWith(value, { signal: expect.any(AbortSignal) });
    }
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
    expect(screen.getByText(/尚未验收/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: '项目成果' })).toBeNull();
    view.rerender(<ProjectDelivery task={{ ...task, status: 'done', repoPath: 'C:/must-not-be-output' }} />);
    expect(screen.queryByText('C:/must-not-be-output')).toBeNull();
    expect(screen.getByText(/成果目录尚未确认/)).toBeTruthy();
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

describe('delivery clipboard request ownership', () => {
  const delivered = (id = 'delivery-a', path = 'C:/output-a'): Task => ({ ...task, id, status: 'done', delivery: { path, branch: `zero/${id}` } });

  it.each([
    ['path', 'resolve'], ['path', 'reject'], ['task', 'resolve'], ['task', 'reject'],
  ] as const)('ignores a stale clipboard %s change followed by %s', async (changed, outcome) => {
    let resolveCopy!: () => void; let rejectCopy!: (error: Error) => void;
    const writeText = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve, reject) => { resolveCopy = resolve; rejectCopy = reject; })).mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const initial = delivered();
    const next = changed === 'path' ? delivered(initial.id, 'C:/output-b') : delivered('delivery-b', initial.delivery!.path);
    const view = render(<ProjectDelivery task={initial} />);
    fireEvent.click(screen.getByRole('button', { name: '复制路径' }));
    expect(writeText).toHaveBeenCalledWith(initial.delivery!.path);
    view.rerender(<ProjectDelivery task={next} />);
    await act(async () => { if (outcome === 'resolve') resolveCopy(); else rejectCopy(new Error('old clipboard denied')); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: '已复制路径' })).toBeNull();
    expect((screen.getByRole('button', { name: '复制路径' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '复制路径' }));
    await screen.findByRole('button', { name: '已复制路径' });
    expect(writeText).toHaveBeenLastCalledWith(next.delivery!.path);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('does not start duplicate writes while the current path is still being copied', async () => {
    let resolveCopy!: () => void;
    const writeText = vi.fn().mockImplementation(() => new Promise<void>(resolve => { resolveCopy = resolve; }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ProjectDelivery task={delivered()} />);
    const copy = screen.getByRole('button', { name: '复制路径' });
    fireEvent.click(copy); fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: '复制中…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolveCopy());
    expect((screen.getByRole('button', { name: '已复制路径' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)('keeps a newer copy in progress after an older request %s and unchanged polling', async outcome => {
    let resolveOld!: () => void; let rejectOld!: (error: Error) => void; let resolveCurrent!: () => void;
    const writeText = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise<void>(resolve => { resolveCurrent = resolve; }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = render(<ProjectDelivery task={delivered()} />);
    fireEvent.click(screen.getByRole('button', { name: '复制路径' }));
    const currentTask = delivered('delivery-b', 'C:/current-output');
    view.rerender(<ProjectDelivery task={currentTask} />);
    fireEvent.click(screen.getByRole('button', { name: '复制路径' }));
    view.rerender(<ProjectDelivery task={{ ...currentTask, updatedAt: '2026-10-27T02:00:00Z', delivery: { ...currentTask.delivery! } }} />);
    await act(async () => { if (outcome === 'resolve') resolveOld(); else rejectOld(new Error('old request failed')); });
    expect((screen.getByRole('button', { name: '复制中…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('status')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '复制中…' })); expect(writeText).toHaveBeenCalledTimes(2);
    await act(async () => resolveCurrent());
    expect(screen.getByRole('button', { name: '已复制路径' })).toBeTruthy();
    expect(writeText).toHaveBeenLastCalledWith('C:/current-output');
  });

  it.each(['resolve', 'reject'] as const)('does not revive an abandoned request after returning to the original delivery: %s', async outcome => {
    let resolveOld!: () => void; let rejectOld!: (error: Error) => void;
    const writeText = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; })).mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const original = delivered();
    const view = render(<ProjectDelivery task={original} />);
    fireEvent.click(screen.getByRole('button', { name: '复制路径' }));
    view.rerender(<ProjectDelivery task={delivered('delivery-b', 'C:/output-b')} />);
    view.rerender(<ProjectDelivery task={{ ...original }} />);
    await act(async () => { if (outcome === 'resolve') resolveOld(); else rejectOld(new Error('abandoned request failed')); });
    expect(screen.queryByRole('status')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '复制路径' }));
    await screen.findByRole('button', { name: '已复制路径' });
    expect(writeText).toHaveBeenCalledTimes(2); expect(writeText).toHaveBeenLastCalledWith(original.delivery!.path);
  });
});

describe('Boss readable project content', () => {
  it('renders the plan and discussion as structured prose rather than literal Markdown', async () => {
    const markdown = '## 实施方案\n\n先确认 **恢复边界**，再实现。\n\n- 保留任务记录\n- 验证交接';
    render(<BossProgress task={{ ...task, bossPlan: { summary: markdown, acceptanceCriteria: ['原有记录完整'], stages: [], checks: [], maxRevisions: 2 }, bossMessages: [{ id: 'formatted', role: 'boss', at: '2026-10-27T00:00:00.000Z', content: '| 检查 | 状态 |\n| --- | --- |\n| 交接 | 已验证 |\n\n```sh\nnpm test\n```' }] }} onMessage={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: '实施方案' })).toBeTruthy();
    expect(screen.getByText('恢复边界').tagName).toBe('STRONG');
    expect(screen.getByRole('table').textContent).toContain('已验证');
    expect(screen.getByText('npm test').closest('pre')).toBeTruthy();
    expect(screen.getByText('保留任务记录').closest('li')).toBeTruthy();
  });
});
