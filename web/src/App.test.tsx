// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { api } from './api';
import type { Config, Task, TaskSequence } from './types';

vi.mock('./api', () => ({ api: { tasks: vi.fn(), task: vi.fn(), capabilities: vi.fn(), sequences: vi.fn(), sequence: vi.fn(), retrySequenceGoalReview: vi.fn(), config: vi.fn(), cancelTask: vi.fn(), createTask: vi.fn(), createSequence: vi.fn(), saveConfig: vi.fn() } }));
const tasks: Task[] = [
  { id: 'alpha', title: '修复登录回调', status: 'running', repoPath: 'C:/repo/zero', route: { harnessId: 'codex', modelId: 'model-a' } },
  { id: 'beta', title: '更新文档', status: 'done', repoPath: 'C:/repo/docs', route: { harnessId: 'dsh' } },
  { id: 'gamma', title: '恢复登录测试', status: 'failed', repoPath: 'C:/repo/zero', route: { harnessId: 'codex' } },
];
const capability = { harnesses: [{ id: 'codex', name: 'Codex', available: true }], bindings: [], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } };
const config = { allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } };
const sharedModelCapabilities = {
  ...capability,
  harnesses: [{ id: 'codex', name: 'Codex', available: true }, { id: 'dsh', name: 'DSH', available: true }, { id: 'offline', name: 'Offline', available: false }],
  bindings: [
    { harnessId: 'codex', modelId: 'shared-model', available: true, reasoningEfforts: [{ id: 'low', label: 'Low' }] },
    { harnessId: 'dsh', modelId: 'shared-model', available: true, reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    { harnessId: 'codex', modelId: 'other-model', available: true, reasoningEfforts: [{ id: 'medium', label: 'Medium' }] },
    { harnessId: 'codex', modelId: 'shared-model', available: false, reasoningEfforts: [{ id: 'xhigh', label: 'Unavailable binding' }] },
    { harnessId: 'offline', modelId: 'shared-model', available: true, reasoningEfforts: [{ id: 'max', label: 'Unavailable harness' }] },
  ],
};
const optionValues = (select: HTMLElement) => Array.from((select as HTMLSelectElement).options).map(option => option.value);
const blockedSequence = (): TaskSequence => ({ id: 'sequence-retry', objective: '可重试的整体目标', status: 'blocked', maxGoalRevisions: 2, goalRevisionCount: 0,
  createdAt: '', updatedAt: '', steps: [{ position: 0, task: { ...tasks[1]!, id: 'step-one' } }, { position: 1, task: { ...tasks[1]!, id: 'step-two' } }],
  goalReview: { state: 'verdict', attemptId: 'blocked-attempt', createdAt: '', result: { verdict: 'blocked', summary: '审核器连接失败', findings: [{ message: '保留上一轮失败发现' }] } } });
async function openSequence(sequence: TaskSequence) {
  vi.mocked(api.sequences).mockResolvedValue([sequence]);
  vi.mocked(api.sequence).mockResolvedValue(sequence);
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: /步骤已完成 · 更新于/ }));
  const dialog = await screen.findByRole('dialog', { name: '目标进度' });
  await within(dialog).findByText(/^有序步骤/);
  return dialog;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.tasks).mockResolvedValue(tasks);
  vi.mocked(api.capabilities).mockResolvedValue(capability);
  vi.mocked(api.sequences).mockResolvedValue([]);
  vi.mocked(api.config).mockResolvedValue(config as Awaited<ReturnType<typeof api.config>>);
  vi.mocked(api.task).mockImplementation(async id => tasks.find(t => t.id === id)!);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('task drawer focus after workspace polling', () => {
  it.each([
    { label: 'replaces the opener task with another task', nextTasks: [tasks[1]!] },
    { label: 'removes every task from the workspace', nextTasks: [] as Task[] },
  ])('returns focus to the main workspace when polling $label', async ({ nextTasks }) => {
    vi.useFakeTimers();
    vi.mocked(api.tasks).mockResolvedValueOnce([tasks[0]!]).mockResolvedValue(nextTasks);
    render(<App />);
    await act(async () => {});
    const opener = screen.getByRole('button', { name: '修复登录回调' });
    opener.focus();
    fireEvent.click(opener);
    await act(async () => {});
    const dialog = screen.getByRole('dialog', { name: '任务详情' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    expect(api.tasks).toHaveBeenCalledTimes(2);
    expect(opener.isConnected).toBe(false);
    expect(screen.queryByRole('button', { name: '修复登录回调' })).toBeNull();
    if (nextTasks.length) expect(screen.getByRole('button', { name: '更新文档' })).toBeTruthy();
    else expect(screen.getByRole('heading', { name: '准备好开始第一个任务' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭详情' }));
    expect(screen.queryByRole('dialog', { name: '任务详情' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
  it('prefers the original task button when it remains mounted after a workspace poll', async () => {
    vi.useFakeTimers();
    vi.mocked(api.tasks).mockResolvedValueOnce([tasks[0]!]).mockResolvedValue([{ ...tasks[0]!, updatedAt: '2026-10-27T03:00:00Z' }, tasks[1]!]);
    render(<App />);
    await act(async () => {});
    const opener = screen.getByRole('button', { name: '修复登录回调' });
    opener.focus();
    fireEvent.click(opener);
    await act(async () => {});
    const dialog = screen.getByRole('dialog', { name: '任务详情' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    expect(api.tasks).toHaveBeenCalledTimes(2);
    expect(opener.isConnected).toBe(true);
    expect(screen.getByRole('button', { name: '修复登录回调' })).toBe(opener);
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭详情' }));
    expect(document.activeElement).toBe(opener);
  });
});

describe('polling workspace filters', () => {
  it.each([
    { view: '列表视图', field: 'Agent 筛选', selected: 'codex', changedTask: { ...tasks[0]!, route: { harnessId: 'zcode' } } },
    { view: '看板视图', field: 'Agent 筛选', selected: 'codex', changedTask: { ...tasks[0]!, route: { harnessId: 'zcode' } } },
    { view: '列表视图', field: '项目筛选', selected: 'C:/repo/zero', changedTask: { ...tasks[0]!, repoPath: 'C:/repo/other' } },
    { view: '看板视图', field: '项目筛选', selected: 'C:/repo/zero', changedTask: { ...tasks[0]!, repoPath: 'C:/repo/other' } },
  ])('retains the selected $field across missing values, reappearance and clear in $view', async scenario => {
    vi.useFakeTimers();
    const initialTasks = [tasks[0]!, tasks[1]!];
    const changedTasks = [scenario.changedTask, tasks[1]!];
    vi.mocked(api.tasks).mockResolvedValueOnce(initialTasks).mockResolvedValueOnce(changedTasks).mockResolvedValueOnce(initialTasks).mockResolvedValue(changedTasks);
    // Task routes determine filter values even when capabilities currently list none.
    vi.mocked(api.capabilities).mockResolvedValue({ ...capability, harnesses: [] });
    render(<App />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: scenario.view }));
    const search = screen.getByRole('searchbox') as HTMLInputElement;
    const status = screen.getByLabelText('状态筛选') as HTMLSelectElement;
    const repo = screen.getByLabelText('项目筛选') as HTMLSelectElement;
    const harness = screen.getByLabelText('Agent 筛选') as HTMLSelectElement;
    fireEvent.change(search, { target: { value: '登录' } });
    fireEvent.change(status, { target: { value: 'running' } });
    fireEvent.change(repo, { target: { value: 'C:/repo/zero' } });
    fireEvent.change(harness, { target: { value: 'codex' } });
    expect(screen.getByText('修复登录回调')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    const selected = screen.getByLabelText(scenario.field) as HTMLSelectElement;
    expect(selected.value).toBe(scenario.selected);
    expect(selected.selectedOptions[0]?.textContent).toContain(scenario.selected);
    expect(screen.getByRole('heading', { name: '没有符合条件的任务' })).toBeTruthy();
    expect(screen.queryByText('修复登录回调')).toBeNull();
    expect(search.value).toBe('登录');
    expect(status.value).toBe('running');
    expect(repo.value).toBe('C:/repo/zero');
    expect(harness.value).toBe('codex');
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    expect(screen.getByText('修复登录回调')).toBeTruthy();
    expect(selected.value).toBe(scenario.selected);
    expect(selected.selectedOptions[0]?.textContent).toBe(scenario.selected);
    expect(optionValues(selected).filter(value => value === scenario.selected)).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(search.value).toBe('');
    expect(status.value).toBe('');
    expect(repo.value).toBe('');
    expect(harness.value).toBe('');
    expect(screen.getByText('修复登录回调')).toBeTruthy();
    expect(screen.getByText('更新文档')).toBeTruthy();
    expect(optionValues(selected)).not.toContain(scenario.selected);
  });
});

describe('settings read recovery', () => {
  it('clears a failed read after retry loads fresh settings and allows editing and saving them', async () => {
    const recovered: Config = {
      allocator: { kind: 'api', modelId: null, reasoningEffort: null, api: { baseUrl: 'https://router.example/v1', model: 'recovered-api-model', keyEnv: 'ZERO_RECOVERED_ROUTER_KEY' } },
      reviewer: { modelId: 'recovered-reviewer', reasoningEffort: 'high' },
    };
    vi.mocked(api.config).mockResolvedValueOnce(config as Config).mockRejectedValueOnce(new Error('initial-config-read-503')).mockResolvedValue(recovered);
    vi.mocked(api.saveConfig).mockImplementation(async value => value);
    render(<App />);
    await screen.findByText('修复登录回调');
    fireEvent.click(screen.getByRole('button', { name: '路由设置' }));
    expect(await screen.findByText('initial-config-read-503')).toBeTruthy();
    expect(screen.queryByRole('group', { name: '路由设置表单' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    const form = await screen.findByRole('group', { name: '路由设置表单' });
    expect((within(form).getByLabelText(/^API HTTPS 地址/) as HTMLInputElement).value).toBe('https://router.example/v1');
    expect((within(form).getByLabelText('API 模型') as HTMLInputElement).value).toBe('recovered-api-model');
    expect((within(form).getByLabelText('审核模型') as HTMLSelectElement).value).toBe('recovered-reviewer');
    expect(screen.queryByText('initial-config-read-503')).toBeNull();
    fireEvent.change(within(form).getByLabelText('API 模型'), { target: { value: 'edited-after-retry' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存设置' }));
    await screen.findByRole('button', { name: '已保存' });
    expect(api.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      allocator: expect.objectContaining({ kind: 'api', api: { baseUrl: 'https://router.example/v1', model: 'edited-after-retry', keyEnv: 'ZERO_RECOVERED_ROUTER_KEY' } }),
      reviewer: { modelId: 'recovered-reviewer', reasoningEffort: 'high' },
    }));
    expect(screen.queryByText('initial-config-read-503')).toBeNull();
  });
  it('shows the latest retry failure without inventing settings or offering save', async () => {
    vi.mocked(api.config).mockResolvedValueOnce(config as Config).mockRejectedValueOnce(new Error('initial-config-read-503')).mockRejectedValue(new Error('latest-config-read-503'));
    render(<App />);
    await screen.findByText('修复登录回调');
    fireEvent.click(screen.getByRole('button', { name: '路由设置' }));
    await screen.findByText('initial-config-read-503');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('latest-config-read-503')).toBeTruthy();
    expect(screen.queryByText('initial-config-read-503')).toBeNull();
    expect(screen.queryByRole('group', { name: '路由设置表单' })).toBeNull();
    expect(screen.queryByRole('button', { name: '保存设置' })).toBeNull();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(api.saveConfig).not.toHaveBeenCalled();
  });
});

describe('sequence repository authoring', () => {
  async function openForm() {
    vi.mocked(api.createSequence).mockResolvedValue(blockedSequence());
    vi.mocked(api.sequence).mockResolvedValue(blockedSequence());
    render(<App />);
    await screen.findByText('修复登录回调');
    fireEvent.click(screen.getAllByRole('button', { name: '高级目标序列' })[0]!);
    return screen.getByRole('dialog', { name: '提交有序任务序列' });
  }
  const rows = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLElement>('.sequence-step-editor'));
  const change = (container: HTMLElement, name: RegExp, value: string) => fireEvent.change(within(container).getByRole('textbox', { name }), { target: { value } });
  function fillRows(dialog: HTMLElement) {
    rows(dialog).forEach((row, index) => {
      change(row, /^步骤 \d+ 描述/, `完成第 ${index + 1} 步实现并检查结果`);
      change(row, /^检查命令/, 'npm test');
    });
  }
  const submitButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: '提交目标序列' }) as HTMLButtonElement;

  it.each([
    { name: 'shared defaults', root: 'C:/A', ref: 'release', overrides: ['', ''], refs: ['', ''], expected: [['C:/A', 'release'], ['C:/A', 'release']] },
    { name: 'mixed roots and refs', root: 'C:/A', ref: 'HEAD', overrides: ['', 'C:/B'], refs: ['', 'release'], expected: [['C:/A', 'HEAD'], ['C:/B', 'release']] },
    { name: 'all roots overridden with no default root', root: '', ref: '', overrides: ['C:/A', 'C:/B'], refs: ['', ''], expected: [['C:/A', 'HEAD'], ['C:/B', 'HEAD']] },
    { name: 'root-only override', root: 'C:/A', ref: 'release', overrides: ['', 'C:/B'], refs: ['', ''], expected: [['C:/A', 'release'], ['C:/B', 'release']] },
    { name: 'ref-only override', root: 'C:/A', ref: 'main', overrides: ['', ''], refs: ['', 'feature'], expected: [['C:/A', 'main'], ['C:/A', 'feature']] },
    { name: 'whitespace inherits and empty default ref uses HEAD', root: '  C:/A  ', ref: '  ', overrides: ['', '  '], refs: ['', '  '], expected: [['C:/A', 'HEAD'], ['C:/A', 'HEAD']] },
  ])('resolves $name identically in row previews and the submitted payload', async scenario => {
    const dialog = await openForm();
    change(dialog, /^(默认)?仓库路径/, scenario.root);
    change(dialog, /^(默认基础 Ref|基础分支)/, scenario.ref);
    fillRows(dialog);
    rows(dialog).forEach((row, index) => {
      if (scenario.overrides[index]) change(row, /^步骤 \d+ 仓库路径/, scenario.overrides[index]!);
      if (scenario.refs[index]) change(row, /^步骤 \d+ 基础 Ref/, scenario.refs[index]!);
      expect(within(row).getByText(scenario.expected[index]![0]!, { exact: true })).toBeTruthy();
      expect(within(row).getByText(scenario.expected[index]![1]!, { exact: true })).toBeTruthy();
    });
    expect((within(dialog).getByRole('textbox', { name: /^(默认)?仓库路径/ }) as HTMLInputElement).required).toBe(false);
    expect(submitButton(dialog).disabled).toBe(false);
    fireEvent.click(submitButton(dialog));
    await screen.findByRole('dialog', { name: '目标进度' });
    const payload = vi.mocked(api.createSequence).mock.calls[0]![0] as { tasks: Array<{ repoPath: string; baseRef: string }> };
    expect(payload.tasks.map(task => [task.repoPath, task.baseRef])).toEqual(scenario.expected);
  });
  it('updates only inherited fields when defaults change and restores inheritance when overrides clear', async () => {
    const dialog = await openForm();
    change(dialog, /^(默认)?仓库路径/, 'C:/A');
    change(dialog, /^(默认基础 Ref|基础分支)/, 'main');
    fillRows(dialog);
    const second = rows(dialog)[1]!;
    change(second, /^步骤 2 仓库路径/, '  C:/B  ');
    change(second, /^步骤 2 基础 Ref/, '  release  ');
    change(dialog, /^(默认)?仓库路径/, 'C:/C');
    change(dialog, /^(默认基础 Ref|基础分支)/, 'develop');
    expect(within(rows(dialog)[0]!).getByText('C:/C')).toBeTruthy();
    expect(within(rows(dialog)[0]!).getByText('develop')).toBeTruthy();
    expect(within(second).getByText('C:/B')).toBeTruthy();
    expect(within(second).getByText('release')).toBeTruthy();
    expect((within(second).getByRole('textbox', { name: /^步骤 2 仓库路径/ }) as HTMLInputElement).value).toBe('  C:/B  ');
    change(second, /^步骤 2 仓库路径/, '');
    change(second, /^步骤 2 基础 Ref/, ' ');
    expect(within(second).getByText('C:/C')).toBeTruthy();
    expect(within(second).getByText('develop')).toBeTruthy();
    fireEvent.click(submitButton(dialog));
    await screen.findByRole('dialog', { name: '目标进度' });
    expect(api.createSequence).toHaveBeenCalledWith(expect.objectContaining({ tasks: [
      expect.objectContaining({ repoPath: 'C:/C', baseRef: 'develop' }),
      expect.objectContaining({ repoPath: 'C:/C', baseRef: 'develop' }),
    ] }));
  });
  it('identifies every missing effective root visibly and rejects a direct submit while preserving drafts', async () => {
    const dialog = await openForm();
    fillRows(dialog);
    expect(submitButton(dialog).disabled).toBe(true);
    rows(dialog).forEach((row, index) => {
      const input = within(row).getByRole('textbox', { name: new RegExp(`^步骤 ${index + 1} 仓库路径`) });
      expect(input.getAttribute('aria-invalid')).toBe('true');
      const message = within(row).getByText(new RegExp(`步骤 ${index + 1} 缺少仓库路径`));
      expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(message.id);
    });
    fireEvent.submit(dialog.querySelector('form')!);
    expect(api.createSequence).not.toHaveBeenCalled();
    expect(rows(dialog)).toHaveLength(2);
    change(rows(dialog)[0]!, /^步骤 1 仓库路径/, 'C:/A');
    expect(within(rows(dialog)[0]!).queryByText(/缺少仓库路径/)).toBeNull();
    expect(within(rows(dialog)[1]!).getByText(/步骤 2 缺少仓库路径/)).toBeTruthy();
    expect(submitButton(dialog).disabled).toBe(true);
    change(dialog, /^(默认)?仓库路径/, 'C:/B');
    expect(within(rows(dialog)[1]!).queryByText(/缺少仓库路径/)).toBeNull();
    expect(submitButton(dialog).disabled).toBe(false);
    expect((within(rows(dialog)[0]!).getByRole('textbox', { name: /^步骤 1 描述/ }) as HTMLTextAreaElement).value).toBe('完成第 1 步实现并检查结果');
  });
  it('keeps complete repository drafts and authored execution locks together when reordered, removed and extended', async () => {
    vi.mocked(api.capabilities).mockResolvedValue(sharedModelCapabilities);
    const dialog = await openForm();
    change(dialog, /^默认仓库路径/, 'C:/default');
    change(dialog, /^默认基础 Ref/, 'main');
    fireEvent.click(within(dialog).getByRole('button', { name: '添加步骤' }));
    const drafts = [
      { root: 'C:/A', ref: 'main', prompt: 'Complete implementation A', criteria: 'A acceptance', checks: 'npm test\nnpm run build', harness: 'codex', model: 'shared-model', effort: 'low' },
      { root: 'C:/B', ref: 'release', prompt: 'Complete implementation B', criteria: 'B acceptance', checks: 'node --version', harness: 'dsh', model: 'shared-model', effort: 'high' },
      { root: 'C:/C', ref: 'develop', prompt: 'Complete implementation C', criteria: 'C acceptance', checks: 'npm run check', harness: '', model: 'other-model', effort: 'medium' },
    ];
    rows(dialog).forEach((row, index) => {
      const draft = drafts[index]!;
      change(row, /^步骤 \d+ 仓库路径/, draft.root);
      change(row, /^步骤 \d+ 基础 Ref/, draft.ref);
      change(row, /^步骤 \d+ 描述/, draft.prompt);
      change(row, /^步骤验收标准/, draft.criteria);
      change(row, /^检查命令/, draft.checks);
      const [harness, model, effort] = within(row).getAllByRole('combobox');
      if (draft.harness) fireEvent.change(harness!, { target: { value: draft.harness } });
      fireEvent.change(model!, { target: { value: draft.model } });
      fireEvent.change(effort!, { target: { value: draft.effort } });
    });
    change(dialog, /^默认仓库路径/, 'C:/new-default');
    change(dialog, /^默认基础 Ref/, 'new-default-ref');
    change(rows(dialog)[0]!, /^步骤 1 仓库路径/, 'C:/A-moved');
    change(rows(dialog)[0]!, /^步骤 1 基础 Ref/, 'topic');
    fireEvent.click(within(dialog).getByRole('button', { name: '将步骤 1 下移' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '将步骤 3 上移' }));
    expect((within(rows(dialog)[1]!).getByRole('textbox', { name: /^步骤 2 描述/ }) as HTMLTextAreaElement).value).toBe('Complete implementation C');
    expect((within(rows(dialog)[2]!).getAllByRole('combobox')[2] as HTMLSelectElement).value).toBe('low');
    expect(within(rows(dialog)[2]!).getByText('C:/A-moved')).toBeTruthy();
    fireEvent.click(within(rows(dialog)[1]!).getByRole('button', { name: '移除' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '添加步骤' }));
    const added = rows(dialog)[2]!;
    expect((within(added).getByRole('textbox', { name: /^步骤 3 仓库路径/ }) as HTMLInputElement).value).toBe('');
    expect((within(added).getByRole('textbox', { name: /^步骤 3 基础 Ref/ }) as HTMLInputElement).value).toBe('');
    expect(within(added).getByText('C:/new-default')).toBeTruthy();
    expect(within(added).getByText('new-default-ref')).toBeTruthy();
    change(added, /^步骤 3 描述/, 'Added inheriting task');
    change(added, /^检查命令/, 'node --version');
    fireEvent.click(submitButton(dialog));
    await screen.findByRole('dialog', { name: '目标进度' });
    expect(api.createSequence).toHaveBeenCalledWith({ maxGoalRevisions: 2, tasks: [
      { repoPath: 'C:/B', baseRef: 'release', prompt: 'Complete implementation B', acceptanceCriteria: 'B acceptance', checkCommands: ['node --version'], maxRevisions: 2, execution: { harnessId: 'dsh', modelId: 'shared-model', reasoningEffort: 'high' } },
      { repoPath: 'C:/A-moved', baseRef: 'topic', prompt: 'Complete implementation A', acceptanceCriteria: 'A acceptance', checkCommands: ['npm test', 'npm run build'], maxRevisions: 2, execution: { harnessId: 'codex', modelId: 'shared-model', reasoningEffort: 'low' } },
      { repoPath: 'C:/new-default', baseRef: 'new-default-ref', prompt: 'Added inheriting task', acceptanceCriteria: '', checkCommands: ['node --version'], maxRevisions: 2, execution: { harnessId: null, modelId: null, reasoningEffort: null } },
    ] });
  });
  it('recomputes missing-root positions after moving and removing rows', async () => {
    const dialog = await openForm();
    fireEvent.click(within(dialog).getByRole('button', { name: '添加步骤' }));
    fillRows(dialog);
    change(rows(dialog)[0]!, /^步骤 1 仓库路径/, 'C:/A');
    change(rows(dialog)[2]!, /^步骤 3 仓库路径/, 'C:/C');
    fireEvent.click(within(dialog).getByRole('button', { name: '将步骤 2 下移' }));
    expect(within(rows(dialog)[2]!).getByText(/步骤 3 缺少仓库路径/)).toBeTruthy();
    expect(within(rows(dialog)[1]!).queryByText(/缺少仓库路径/)).toBeNull();
    expect((within(rows(dialog)[2]!).getByRole('textbox', { name: /^步骤 3 描述/ }) as HTMLTextAreaElement).value).toBe('完成第 2 步实现并检查结果');
    fireEvent.click(within(rows(dialog)[0]!).getByRole('button', { name: '移除' }));
    expect(within(rows(dialog)[1]!).getByText(/步骤 2 缺少仓库路径/)).toBeTruthy();
    expect(within(dialog).queryByText(/步骤 3 缺少仓库路径/)).toBeNull();
    expect(submitButton(dialog).disabled).toBe(true);
    change(dialog, /^默认仓库路径/, 'C:/B');
    expect(within(dialog).queryByText(/缺少仓库路径/)).toBeNull();
    expect(within(rows(dialog)[0]!).getByText('C:/C')).toBeTruthy();
    expect(within(rows(dialog)[1]!).getByText('C:/B')).toBeTruthy();
    expect(submitButton(dialog).disabled).toBe(false);
  });
  it('protects repository drafts while busy and preserves the exact payload after a rejected submission', async () => {
    vi.mocked(api.capabilities).mockResolvedValue(sharedModelCapabilities);
    const dialog = await openForm();
    let reject!: (error: Error) => void;
    vi.mocked(api.createSequence).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    fillRows(dialog);
    change(rows(dialog)[0]!, /^步骤 1 仓库路径/, 'C:/A');
    change(rows(dialog)[1]!, /^步骤 2 仓库路径/, 'C:/B');
    change(rows(dialog)[1]!, /^步骤 2 基础 Ref/, 'release');
    const [harness, model, effort] = within(rows(dialog)[1]!).getAllByRole('combobox');
    fireEvent.change(harness!, { target: { value: 'dsh' } });
    fireEvent.change(model!, { target: { value: 'shared-model' } });
    fireEvent.change(effort!, { target: { value: 'high' } });
    fireEvent.click(submitButton(dialog));
    const fieldset = dialog.querySelector('fieldset')!;
    expect(fieldset.disabled).toBe(true);
    expect(Array.from(dialog.querySelectorAll('input, textarea, select')).every(input => input.closest('fieldset:disabled') === fieldset)).toBe(true);
    expect(within(dialog).getByRole('button', { name: '添加步骤' }).closest('fieldset:disabled')).toBe(fieldset);
    expect(within(dialog).getByRole('button', { name: '将步骤 1 下移' }).closest('fieldset:disabled')).toBe(fieldset);
    expect(within(rows(dialog)[0]!).getByRole('button', { name: '移除' }).closest('fieldset:disabled')).toBe(fieldset);
    expect((within(dialog).getByRole('button', { name: '关闭对话框' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.mouseDown(dialog.parentElement!);
    fireEvent.submit(dialog.querySelector('form')!);
    expect(screen.getByRole('dialog', { name: '提交有序任务序列' })).toBe(dialog);
    expect(api.createSequence).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('项目默认执行组合不兼容')));
    expect(within(dialog).getByText('项目默认执行组合不兼容')).toBeTruthy();
    expect(fieldset.disabled).toBe(false);
    expect((within(rows(dialog)[1]!).getByRole('textbox', { name: /^步骤 2 仓库路径/ }) as HTMLInputElement).value).toBe('C:/B');
    expect((effort as HTMLSelectElement).value).toBe('high');
    expect(submitButton(dialog).disabled).toBe(false);
    fireEvent.click(submitButton(dialog));
    await screen.findByRole('dialog', { name: '目标进度' });
    expect(api.createSequence).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.createSequence).mock.calls[1]![0]).toEqual(vi.mocked(api.createSequence).mock.calls[0]![0]);
  });
  it('keeps the two-to-sixteen step editing bounds with repository fields present', async () => {
    const dialog = await openForm();
    expect(rows(dialog)).toHaveLength(2);
    expect(within(rows(dialog)[0]!).getByRole('button', { name: '移除' }).matches(':disabled')).toBe(true);
    expect(within(rows(dialog)[1]!).getByRole('button', { name: '移除' }).matches(':disabled')).toBe(true);
    const add = within(dialog).getByRole('button', { name: '添加步骤' });
    for (let index = 2; index < 16; index++) fireEvent.click(add);
    expect(rows(dialog)).toHaveLength(16);
    expect((add as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(add);
    expect(rows(dialog)).toHaveLength(16);
    expect(within(rows(dialog)[15]!).getByRole('textbox', { name: /^步骤 16 仓库路径/ })).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: '将步骤 1 上移' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: '将步骤 16 下移' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('task workspace', () => {
  it('keeps long goal titles bounded while preserving the full objective and criteria in the scrollable drawer', async () => {
    const sequence = blockedSequence();
    sequence.objective = 'Implement the detailed product requirements. '.repeat(240).slice(0, 10000);
    sequence.acceptanceCriteria = ['Preserve every detailed requirement'];
    const dialog = await openSequence(sequence);
    expect(within(dialog).getByRole('heading', { level: 2 }).textContent!.length).toBeLessThan(150);
    expect(document.querySelector('.sequence-card-head b')!.textContent!.length).toBeLessThan(150);
    const content = dialog.querySelector<HTMLElement>('.drawer-content')!;
    expect(within(content).getByRole('heading', { name: '整体目标' })).toBeTruthy();
    expect(content.textContent).toContain(sequence.objective);
    expect(within(content).getByText('Preserve every detailed requirement')).toBeTruthy();
    expect((within(content).getByRole('button', { name: '重新验收' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('keeps cached goal cards usable after a failed poll and replaces them on recovery', async () => {
    vi.useFakeTimers();
    const sequence = blockedSequence();
    vi.mocked(api.sequences).mockResolvedValueOnce([sequence]).mockRejectedValueOnce(new Error('sequence endpoint 503')).mockResolvedValue([{ ...sequence, objective: '恢复后的目标' }]);
    vi.mocked(api.sequence).mockResolvedValue(sequence);
    render(<App />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: /可重试的整体目标.*步骤已完成/ })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    const retainedCard = screen.getByRole('button', { name: /可重试的整体目标.*步骤已完成/ });
    const warning = screen.getByRole('alert');
    expect(warning.textContent).toContain('sequence endpoint 503');
    expect(warning.textContent).toContain('上次同步');
    fireEvent.click(retainedCard);
    await act(async () => {});
    const dialog = screen.getByRole('dialog', { name: '目标进度' });
    expect(within(dialog).getByRole('heading', { name: '可重试的整体目标' })).toBeTruthy();
    expect(within(dialog).getByText(/^有序步骤/)).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /可重试的整体目标.*步骤已完成/ })).toBeNull();
    expect(screen.getByRole('button', { name: /恢复后的目标.*步骤已完成/ })).toBeTruthy();
  });
  it('shows an initial goal-list error without cached cards and clears it after a successful refresh', async () => {
    vi.mocked(api.sequences).mockRejectedValueOnce(new Error('initial sequence endpoint 503')).mockResolvedValue([blockedSequence()]);
    const { container } = render(<App />);
    expect(await screen.findByText('initial sequence endpoint 503')).toBeTruthy();
    expect(container.querySelectorAll('.sequence-card')).toHaveLength(0);
    expect(screen.queryByText(/上次同步的目标/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '刷新工作区' }));
    expect(await screen.findByRole('button', { name: /可重试的整体目标.*步骤已完成/ })).toBeTruthy();
    expect(screen.queryByText('initial sequence endpoint 503')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('unions available shared-model efforts without a harness lock and submits the chosen effort', async () => {
    vi.mocked(api.capabilities).mockResolvedValue(sharedModelCapabilities);
    vi.mocked(api.createTask).mockResolvedValue(tasks[0]!);
    render(<App />);
    await screen.findByText('修复登录回调');
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    const dialog = screen.getByRole('dialog', { name: '提交执行任务' });
    const [harness, model, effort] = within(dialog).getAllByRole('combobox');
    fireEvent.change(model!, { target: { value: 'shared-model' } });
    expect(optionValues(effort!)).toEqual(['', 'low', 'high']);
    fireEvent.change(effort!, { target: { value: 'high' } });
    expect((harness as HTMLSelectElement).value).toBe('');
    fireEvent.change(within(dialog).getByLabelText(/仓库路径/), { target: { value: 'C:/repo/zero' } });
    fireEvent.change(within(dialog).getByLabelText('任务描述 *'), { target: { value: '共享模型可自动选择执行器' } });
    fireEvent.change(within(dialog).getByLabelText(/检查命令/), { target: { value: 'npm test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '加入任务队列' }));
    await screen.findByRole('dialog', { name: '任务详情' });
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ execution: { harnessId: null, modelId: 'shared-model', reasoningEffort: 'high' } }));
  });
  it('narrows shared-model efforts to an explicit harness and clears dependent choices when changed', async () => {
    vi.mocked(api.capabilities).mockResolvedValue(sharedModelCapabilities);
    render(<App />);
    await screen.findByText('修复登录回调');
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    const [harness, model, effort] = within(screen.getByRole('dialog')).getAllByRole('combobox');
    fireEvent.change(harness!, { target: { value: 'dsh' } });
    fireEvent.change(model!, { target: { value: 'shared-model' } });
    expect(optionValues(effort!)).toEqual(['', 'low', 'high']);
    fireEvent.change(effort!, { target: { value: 'high' } });
    fireEvent.change(harness!, { target: { value: 'codex' } });
    expect((model as HTMLSelectElement).value).toBe('');
    expect((effort as HTMLSelectElement).value).toBe('');
    fireEvent.change(model!, { target: { value: 'shared-model' } });
    expect(optionValues(effort!)).toEqual(['', 'low']);
    fireEvent.change(effort!, { target: { value: 'low' } });
    fireEvent.change(model!, { target: { value: 'other-model' } });
    expect((effort as HTMLSelectElement).value).toBe('');
    expect(optionValues(effort!)).toEqual(['', 'medium']);
  });
  it('preserves shared-model effort selections while capabilities fail or temporarily lose available bindings', async () => {
    vi.useFakeTimers();
    vi.mocked(api.capabilities).mockResolvedValueOnce(sharedModelCapabilities).mockRejectedValueOnce(new Error('capabilities 503')).mockResolvedValueOnce({ ...sharedModelCapabilities, bindings: [] }).mockResolvedValue(sharedModelCapabilities);
    render(<App />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    const [harness, model, effort] = within(screen.getByRole('dialog')).getAllByRole('combobox');
    fireEvent.change(model!, { target: { value: 'shared-model' } });
    fireEvent.change(effort!, { target: { value: 'high' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect((harness as HTMLSelectElement).value).toBe('');
    expect((model as HTMLSelectElement).value).toBe('shared-model');
    expect((effort as HTMLSelectElement).value).toBe('high');
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect((model as HTMLSelectElement).value).toBe('shared-model');
    expect((effort as HTMLSelectElement).value).toBe('high');
    expect((within(effort!).getByRole('option', { name: /high.*当前不可用/ }) as HTMLOptionElement).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect((effort as HTMLSelectElement).value).toBe('high');
    expect((within(effort!).getByRole('option', { name: 'High' }) as HTMLOptionElement).disabled).toBe(false);
  });
  it('keeps sequence-step shared-model efforts unioned and narrows them for an explicit harness', async () => {
    vi.mocked(api.capabilities).mockResolvedValue(sharedModelCapabilities);
    render(<App />);
    await screen.findByText('修复登录回调');
    fireEvent.click(screen.getAllByRole('button', { name: '高级目标序列' })[0]!);
    const dialog = screen.getByRole('dialog', { name: '提交有序任务序列' });
    const step = within(dialog).getByLabelText('步骤 1 描述 *').closest('.sequence-step-editor')!;
    const [harness, model, effort] = within(step as HTMLElement).getAllByRole('combobox');
    fireEvent.change(model!, { target: { value: 'shared-model' } });
    expect(optionValues(effort!)).toEqual(['', 'low', 'high']);
    fireEvent.change(harness!, { target: { value: 'codex' } });
    fireEvent.change(model!, { target: { value: 'shared-model' } });
    expect(optionValues(effort!)).toEqual(['', 'low']);
  });
  it('shows the selected remediation repository and opens that earlier task', async () => {
    const sequence = blockedSequence();
    sequence.steps[0]!.task = { ...sequence.steps[0]!.task, repoPath: 'C:/projects/server' };
    sequence.steps[1]!.task = { ...sequence.steps[1]!.task, repoPath: 'C:/projects/client' };
    sequence.goalReview!.result = { verdict: 'changes_requested', summary: '服务端需要补充校验', targetTaskId: 'step-one', findings: [{ message: '检查接口契约' }] };
    vi.mocked(api.task).mockResolvedValue(sequence.steps[0]!.task);
    const dialog = await openSequence(sequence);
    const target = within(dialog).getByRole('region', { name: '本轮返工目标' });
    expect(within(target).getByText('C:/projects/server')).toBeTruthy();
    expect(within(target).queryByText('C:/projects/client')).toBeNull();
    fireEvent.click(within(target).getByRole('button', { name: '查看目标步骤' }));
    await screen.findByRole('dialog', { name: '任务详情' });
    expect(vi.mocked(api.task).mock.calls[0]?.[0]).toBe('step-one');
  });
  it('queues the exact blocked goal attempt once and keeps its findings during a delayed refresh', async () => {
    const sequence = blockedSequence();
    const dialog = await openSequence(sequence);
    let finish!: (value: TaskSequence) => void;
    vi.mocked(api.retrySequenceGoalReview).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let refresh!: (value: TaskSequence) => void;
    vi.mocked(api.sequence).mockImplementation(() => new Promise(resolve => { refresh = resolve; }));
    const button = within(dialog).getByRole('button', { name: '重新验收' });
    fireEvent.click(button);
    expect(api.retrySequenceGoalReview).toHaveBeenCalledWith('sequence-retry', 'blocked-attempt');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(sequence));
    expect(await within(dialog).findByText(/重新验收已排队/)).toBeTruthy();
    expect(within(dialog).getByText(/保留上一轮失败发现/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '重新验收' }));
    expect(api.retrySequenceGoalReview).toHaveBeenCalledTimes(1);
    await act(async () => refresh({ ...sequence, goalReview: { ...sequence.goalReview!, attemptId: 'next-blocked-attempt' } }));
    expect((within(dialog).getByRole('button', { name: '重新验收' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: '重新验收' }));
    expect(api.retrySequenceGoalReview).toHaveBeenLastCalledWith('sequence-retry', 'next-blocked-attempt');
  });
  it('shows persisted goal retry queue state and retains the previous verdict', async () => {
    const sequence = blockedSequence();
    sequence.goalReview = { ...sequence.goalReview!, retryRequestedAt: '2026-10-18T00:00:00Z' };
    const dialog = await openSequence(sequence);
    expect(within(dialog).getByText(/重新验收已排队/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: '重新验收' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(/保留上一轮失败发现/)).toBeTruthy();
  });
  it('allows retry when goal acceptance criteria exist without an objective title', async () => {
    const sequence = blockedSequence();
    delete sequence.objective;
    sequence.acceptanceCriteria = ['整体结果需要通过验收'];
    const dialog = await openSequence(sequence);
    expect((within(dialog).getByRole('button', { name: '重新验收' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('shows the retry error until a newer goal attempt loads after a rejected stale retry', async () => {
    const sequence = blockedSequence();
    const dialog = await openSequence(sequence);
    vi.mocked(api.retrySequenceGoalReview).mockRejectedValue(new Error('验收尝试已变化，请刷新'));
    let finishRefresh!: (value: TaskSequence) => void;
    vi.mocked(api.sequence).mockImplementation(() => new Promise(resolve => { finishRefresh = resolve; }));
    fireEvent.click(within(dialog).getByRole('button', { name: '重新验收' }));
    expect(await within(dialog).findByText('验收尝试已变化，请刷新')).toBeTruthy();
    expect(api.retrySequenceGoalReview).toHaveBeenCalledWith('sequence-retry', 'blocked-attempt');
    expect(api.sequence).toHaveBeenCalledTimes(2);
    await act(async () => finishRefresh({ ...sequence, goalReview: { state: 'running', attemptId: 'latest-attempt', createdAt: '' } }));
    expect(await within(dialog).findByText('正在进行目标级 Codex 验收')).toBeTruthy();
    expect(within(dialog).queryByText('验收尝试已变化，请刷新')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '重新验收' })).toBeNull();
    expect(api.sequence).toHaveBeenCalledTimes(2);
  });
  it.each(['legacy', 'pass', 'changes_requested', 'running', 'quota', 'incomplete', 'no-goal'])(
    'does not offer a blocked-goal retry for %s state', async state => {
      const sequence = blockedSequence();
      if (state === 'legacy') delete sequence.goalReview!.attemptId;
      else if (state === 'incomplete') sequence.steps[0]!.task.status = 'running';
      else if (state === 'no-goal') delete sequence.objective;
      else if (state === 'running' || state === 'quota') sequence.goalReview = { ...sequence.goalReview!, state };
      else sequence.goalReview!.result!.verdict = state;
      const dialog = await openSequence(sequence);
      expect(within(dialog).queryByRole('button', { name: '重新验收' })).toBeNull();
    });
  it('shows the observed attempt error alongside a separately labelled executor claim', async () => {
    vi.mocked(api.task).mockResolvedValue({ ...tasks[0]!, attempts: [{ id: 'failed-attempt', status: 'failed',
      summary: 'Harness reported a different model', executorSummary: 'I completed the task.' }] } as Task);
    render(<App />);
    fireEvent.click(await screen.findByText('修复登录回调'));
    expect(await screen.findByText('Harness reported a different model')).toBeTruthy();
    expect(await screen.findByText('I completed the task.')).toBeTruthy();
    expect(screen.getByText('执行者自述，需结合检查与审查确认')).toBeTruthy();
  });
  it('keeps stage goals with their execution routes when reordered and removed before submission', async () => {
    vi.mocked(api.capabilities).mockResolvedValue({ ...capability, bindings: [{ harnessId: 'codex', modelId: 'model-a', available: true, reasoningEfforts: [] }] });
    vi.mocked(api.createTask).mockResolvedValue({ ...tasks[0]!, id: 'created-relay' });
    vi.mocked(api.task).mockResolvedValue({ ...tasks[0]!, id: 'created-relay' });
    render(<App />);
    await screen.findByText('修复登录回调');
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    const dialog = screen.getByRole('dialog', { name: '提交执行任务' });
    fireEvent.change(within(dialog).getByLabelText(/仓库路径/), { target: { value: 'C:/repo/zero' } });
    fireEvent.change(within(dialog).getByLabelText('任务描述 *'), { target: { value: '实现登录并由另一名执行者补全检查' } });
    fireEvent.change(within(dialog).getByLabelText(/检查命令/), { target: { value: 'npm test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '添加阶段' }));
    fireEvent.change(within(dialog).getByLabelText('阶段 1 目标'), { target: { value: '  实现登录接口  ' } });
    const firstStage = within(dialog).getByLabelText('阶段 1 目标').closest('.execution-stage')!;
    fireEvent.change(within(firstStage as HTMLElement).getByLabelText('Harness'), { target: { value: 'codex' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '添加阶段' }));
    fireEvent.change(within(dialog).getByLabelText('阶段 2 目标'), { target: { value: '补充失败路径的检查' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '将阶段 2 上移' }));
    expect((within(dialog).getByLabelText('阶段 1 目标') as HTMLTextAreaElement).value).toBe('补充失败路径的检查');
    fireEvent.click(within(dialog).getByRole('button', { name: '添加阶段' }));
    fireEvent.change(within(dialog).getByLabelText('阶段 3 目标'), { target: { value: '应移除的临时阶段' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '移除阶段 3' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '加入任务队列' }));
    await screen.findByRole('button', { name: '关闭详情' });
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ executionStages: [
      { objective: '补充失败路径的检查' }, { harnessId: 'codex', objective: '实现登录接口' },
    ] }));
  });
  it('renders submitted stage goals and labels executor summaries as untrusted plain text', async () => {
    const summary = '<img src=x onerror=alert(1)> 已修改接口，检查尚未执行';
    vi.mocked(api.task).mockResolvedValue({ ...tasks[0]!, executionStages: [{ objective: '先实现，再补充异常检查' }],
      handoffs: [{ id: 'semantic-handoff', stageId: 'stage-one', createdAt: '', source: { attemptId: 'a1', harness: 'codex', model: 'model-a' }, workspace: { state: 'dirty' }, completed: [], currentState: '等待后续处理', decisions: [], keyFiles: [], checks: [], blockers: [], risks: [], nextSteps: [], executorSummary: summary }],
    } as Task);
    render(<App />);
    fireEvent.click(await screen.findByText('修复登录回调'));
    expect(await screen.findByText('先实现，再补充异常检查')).toBeTruthy();
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.getByText('执行者自述，需结合检查与审查确认')).toBeTruthy();
    expect(screen.getByRole('dialog').querySelector('img')).toBeNull();
  });
  it('separates superseded checks from the current verified run', async () => {
    vi.mocked(api.task).mockResolvedValue({ ...tasks[1]!, tests: [{ command: 'current-unit-check', status: 'passed' }],
      historicalTests: [{ command: 'superseded-unit-check', status: 'failed', output: 'before revision' }],
      checkEvidence: { state: 'current', runId: 'run-2', stageId: 'stage-2', attemptId: 'attempt-2', status: 'passed' },
    } as Task);
    render(<App />);
    fireEvent.click(await screen.findByText('更新文档'));
    await screen.findByText('current-unit-check');
    const current = screen.getByRole('region', { name: '当前检查结果' });
    const historical = screen.getByText(/历史检查记录/).closest('details')!;
    expect(within(current).getByText('current-unit-check')).toBeTruthy();
    expect(within(current).queryByText('superseded-unit-check')).toBeNull();
    expect(within(historical).getByText('superseded-unit-check')).toBeTruthy();
    expect(screen.getByText('run-2')).toBeTruthy();
  });
  it('does not describe unattributed legacy checks as current validation', async () => {
    vi.mocked(api.task).mockResolvedValue({ ...tasks[1]!, tests: [{ command: 'legacy-check', status: 'passed' }], checkEvidence: { state: 'unattributed' } } as Task);
    render(<App />);
    fireEvent.click(await screen.findByText('更新文档'));
    await screen.findByText('legacy-check');
    expect(screen.getByText('检查归属尚未确认')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '当前检查结果' })).toBeNull();
  });
  it('clears active filters from a matching list without waiting for an empty result', async () => {
    render(<App />);
    await screen.findByText('修复登录回调');
    fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'running' } });
    expect(screen.getAllByRole('row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect((screen.getByLabelText('状态筛选') as HTMLSelectElement).value).toBe('');
  });
  it('clears only search and returns focus while preserving the status filter', async () => {
    render(<App />);
    await screen.findByText('修复登录回调');
    fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'running' } });
    const input = screen.getByRole('searchbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '登录' } });
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(input.value).toBe(''); expect(document.activeElement).toBe(input);
    expect((screen.getByLabelText('状态筛选') as HTMLSelectElement).value).toBe('running');
    fireEvent.change(input, { target: { value: '登录' } });
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(input.value).toBe('登录');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
  });
  it('combines list-title search, status, repository and Harness filters in the default table', async () => {
    render(<App />);
    await screen.findByText('修复登录回调');
    expect(screen.getByRole('table')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '登录' } });
    expect(screen.queryByText('更新文档')).toBeNull();
    fireEvent.change(screen.getByLabelText('项目筛选'), { target: { value: 'C:/repo/zero' } });
    fireEvent.change(screen.getByLabelText('Agent 筛选'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'done' } });
    expect(screen.getByText('没有符合条件的任务')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(screen.getByLabelText('全部任务 3')).toBeTruthy();
  });
  it('shows task checks, duration and output even when attempts exist', async () => {
    vi.mocked(api.task).mockResolvedValue({ ...tasks[0]!, attempts: [{ number: 1, status: 'failed' }], tests: [{ command: 'npm test', status: 'timed_out', durationMs: 1200, output: 'worker check timed out' }] });
    render(<App />);
    fireEvent.click(await screen.findByText('修复登录回调'));
    expect(await screen.findByText('npm test')).toBeTruthy();
    expect(screen.getByText('worker check timed out')).toBeTruthy();
    expect(screen.getByText('1.2 秒')).toBeTruthy();
  });
  it('never displays stale details under another task selection or accepts a mismatched response', async () => {
    let resolveBeta: (task: Task) => void = () => {};
    vi.mocked(api.task).mockImplementation(id => id === 'beta' ? new Promise(resolve => { resolveBeta = resolve; }) : Promise.resolve(tasks[0]!));
    render(<App />);
    fireEvent.click(await screen.findByText('修复登录回调'));
    await screen.findByRole('button', { name: '取消任务' });
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
    fireEvent.click(screen.getByText('更新文档'));
    expect(screen.queryByRole('button', { name: '取消任务' })).toBeNull();
    await act(async () => resolveBeta(tasks[0]!));
    expect(screen.queryByRole('button', { name: '取消任务' })).toBeNull();
    expect(screen.getByText(/任务身份不匹配/)).toBeTruthy();
  });
  it('requires checks, defaults to HEAD and protects a pending submission from closing', async () => {
    vi.mocked(api.createTask).mockReturnValue(new Promise(() => {}));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    const dialog = screen.getByRole('dialog', { name: '提交执行任务' });
    expect(within(dialog).getByDisplayValue('HEAD')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/仓库路径/), { target: { value: 'C:/repo/zero' } });
    fireEvent.change(within(dialog).getByLabelText('任务描述 *'), { target: { value: '修复登录任务回调错误' } });
    expect((within(dialog).getByRole('button', { name: '加入任务队列' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/检查命令/), { target: { value: 'npm test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '加入任务队列' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: '关闭对话框' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps cached task evidence visible with a stale banner after refresh fails', async () => {
    vi.useFakeTimers();
    vi.mocked(api.task).mockResolvedValueOnce({ ...tasks[0]!, tests: [{ command: 'check-evidence', status: 'passed' }] }).mockRejectedValue(new Error('服务暂不可用'));
    render(<App />);
    await act(async () => {});
    fireEvent.click(screen.getByText('修复登录回调'));
    await act(async () => {});
    expect(screen.getByText('check-evidence')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(screen.getByText('刷新失败，显示上次同步内容')).toBeTruthy();
    expect(screen.getByText('check-evidence')).toBeTruthy();
  });
  it('refreshes capabilities periodically and keeps each task poll serial', async () => {
    vi.useFakeTimers();
    let resolveTasks: (value: Task[]) => void = () => {};
    vi.mocked(api.tasks).mockReturnValueOnce(new Promise(resolve => { resolveTasks = resolve; }));
    const { unmount } = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    expect(api.tasks).toHaveBeenCalledTimes(1);
    expect(api.capabilities).toHaveBeenCalledTimes(2);
    await act(async () => resolveTasks(tasks));
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    expect(api.tasks).toHaveBeenCalledTimes(2);
    const signal = vi.mocked(api.tasks).mock.calls[0]?.[0]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
  });
  it('shows unavailable saved role choices and preserves them while saving an unrelated edit', async () => {
    const stored = { allocator: { kind: 'codex' as const, modelId: 'saved-router', reasoningEffort: 'high' },
      reviewer: { modelId: 'saved-reviewer', reasoningEffort: 'xhigh' } };
    vi.mocked(api.config).mockResolvedValue(stored);
    vi.mocked(api.saveConfig).mockImplementation(async value => value);
    render(<App />);
    await screen.findByText('修复登录回调');
    fireEvent.click(screen.getByRole('button', { name: '路由设置' }));
    const router = await screen.findByLabelText('默认模型');
    const reviewer = screen.getByLabelText('审核模型');
    expect((router as HTMLSelectElement).value).toBe('saved-router');
    expect((reviewer as HTMLSelectElement).value).toBe('saved-reviewer');
    expect(within(router).getByRole('option', { name: 'saved-router（当前不可用）' })).toBeTruthy();
    expect((screen.getByLabelText('审核思考强度') as HTMLSelectElement).value).toBe('xhigh');
    fireEvent.change(screen.getByLabelText('分配器来源'), { target: { value: 'api' } });
    fireEvent.change(screen.getByLabelText(/^API HTTPS 地址/), { target: { value: 'https://provider.example/v1' } });
    fireEvent.change(screen.getByLabelText('API 模型'), { target: { value: 'router' } });
    fireEvent.change(screen.getByLabelText(/^密钥环境变量名/), { target: { value: 'ZERO_ROUTER_KEY' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await screen.findByRole('status');
    expect(api.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ reviewer: stored.reviewer }));
  });
  it('disables every settings field while saving the edited configuration', async () => {
    vi.mocked(api.saveConfig).mockReturnValue(new Promise(() => {}));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '路由设置' }));
    fireEvent.click(await screen.findByRole('button', { name: '保存设置' }));
    const fields = screen.getByRole('group', { name: '路由设置表单' });
    expect((fields as HTMLFieldSetElement).disabled).toBe(true);
    expect(fields.contains(screen.getByLabelText('分配器来源'))).toBe(true);
  });
  it('requires a check command for every sequence step', async () => {
    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: '高级目标序列' })[0]!);
    const dialog = screen.getByRole('dialog', { name: '提交有序任务序列' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^默认仓库路径/ }), { target: { value: 'C:/repo/zero' } });
    fireEvent.change(within(dialog).getByLabelText('步骤 1 描述 *'), { target: { value: '完成第一步修改并运行检查' } });
    fireEvent.change(within(dialog).getByLabelText('步骤 2 描述 *'), { target: { value: '完成第二步修改并运行检查' } });
    const checks = within(dialog).getAllByLabelText(/检查命令/);
    fireEvent.change(checks[0]!, { target: { value: 'npm test' } });
    const submit = within(dialog).getByRole('button', { name: '提交目标序列' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(checks[1]!, { target: { value: 'npm run build' } });
    expect(submit.disabled).toBe(false);
  });
  it('renders ordered stage routing and real handoff evidence', async () => {
    vi.mocked(api.task).mockResolvedValue({ ...tasks[0]!, stages: [{ id: 's2', sequence: 2, role: 'implement', status: 'running', createdAt: '', harness: 'dsh', model: 'route-two' }, { id: 's1', sequence: 1, role: 'implement', status: 'succeeded', createdAt: '', harness: 'codex', model: 'route-one', inputFingerprint: 'input-123' }], handoffs: [{ id: 'handoff-1', stageId: 's1', createdAt: '', source: { attemptId: 'attempt-1', harness: 'codex', model: 'route-one' }, workspace: { state: 'dirty', changedFiles: ['src/login.ts'] }, completed: ['修复 cookie'], currentState: '检查完成，等待下一阶段', decisions: [], keyFiles: [], checks: [{ id: 'unit', status: 'passed', evidence: '42 passed' }], blockers: [], risks: [], nextSteps: ['继续审核'] }] });
    render(<App />);
    fireEvent.click(await screen.findByText('修复登录回调'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('检查完成，等待下一阶段');
    expect(within(dialog).getByText('src/login.ts')).toBeTruthy();
    expect(within(dialog).getByText('继续审核')).toBeTruthy();
    const stageHeadings = Array.from(dialog.querySelectorAll('.stage-heading')).map(node => node.textContent);
    expect(stageHeadings[0]).toContain('阶段 1');
    expect(dialog.textContent!.indexOf('route-one')).toBeLessThan(dialog.textContent!.indexOf('route-two'));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('safely renders a legacy task without stage and handoff records', async () => {
    vi.mocked(api.task).mockResolvedValue(tasks[1]!);
    render(<App />);
    fireEvent.click(await screen.findByText('更新文档'));
    expect(await screen.findByText('尚未产生 Agent 交接记录。')).toBeTruthy();
    expect(screen.getByText('尚无阶段执行记录。历史任务可能未记录阶段与交接证据。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取消任务' })).toBeNull();
  });
  it('keeps visible detail summaries in the keyboard loop and excludes closed detail contents', async () => {
    vi.mocked(api.task).mockResolvedValue({ ...tasks[0]!, stages: [{ id: 's1', sequence: 1, role: 'implement', status: 'succeeded', createdAt: '' }] });
    render(<App />);
    fireEvent.click(await screen.findByText('修复登录回调'));
    const summary = await screen.findByText('阶段标识与工作区指纹');
    const dialog = screen.getByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: '取消任务' });
    const close = within(dialog).getByRole('button', { name: '关闭详情' });
    cancel.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    cancel.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(false);
    // The browser advances to summary on an unhandled Tab. jsdom has no native tab navigation.
    summary.focus();
    const details = summary.closest('details')!;
    const hiddenButton = document.createElement('button');
    hiddenButton.textContent = '关闭折叠项内部的按钮';
    details.append(hiddenButton);
    const hiddenSibling = document.createElement('button');
    hiddenSibling.hidden = true;
    dialog.append(hiddenSibling);
    const end = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    summary.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    const backwards = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    close.dispatchEvent(backwards);
    expect(document.activeElement).toBe(summary);
  });
  it('keeps keyboard focus inside a submitting dialog after its controls become disabled', async () => {
    vi.mocked(api.createTask).mockImplementation(() => new Promise(() => {}));
    render(<App />);
    const opener = await screen.findByRole('button', { name: '提交任务' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
    const dialog = screen.getByRole('dialog', { name: '提交执行任务' });
    fireEvent.change(within(dialog).getByLabelText(/仓库路径/), { target: { value: 'C:/repo/zero' } });
    fireEvent.change(within(dialog).getByLabelText('任务描述 *'), { target: { value: '完成目标并检查结果' } });
    fireEvent.change(within(dialog).getByLabelText(/检查命令/), { target: { value: 'npm test' } });
    const submit = within(dialog).getByRole('button', { name: '加入任务队列' });
    submit.focus();
    fireEvent.click(submit);
    expect(document.activeElement).toBe(dialog);
    // Disabled controls can leave BODY focused in a native browser.
    (document.activeElement as HTMLElement).blur();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.body.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
  it('redirects background focus into the dialog and restores the opener after closing', async () => {
    render(<App />);
    const opener = await screen.findByRole('button', { name: '提交任务' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: '交给 Boss' });
    screen.getByRole('button', { name: '路由设置' }).focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    screen.getByRole('button', { name: '路由设置' }).focus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '路由设置' }));
  });
});
