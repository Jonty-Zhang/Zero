// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { api } from './api';
import type { Task } from './types';

vi.mock('./api', () => ({ api: { tasks: vi.fn(), task: vi.fn(), capabilities: vi.fn(), sequences: vi.fn(), config: vi.fn(), cancelTask: vi.fn(), createTask: vi.fn(), createSequence: vi.fn(), saveConfig: vi.fn() } }));
const tasks: Task[] = [
  { id: 'alpha', title: '修复登录回调', status: 'running', repoPath: 'C:/repo/zero', route: { harnessId: 'codex', modelId: 'model-a' } },
  { id: 'beta', title: '更新文档', status: 'done', repoPath: 'C:/repo/docs', route: { harnessId: 'dsh' } },
  { id: 'gamma', title: '恢复登录测试', status: 'failed', repoPath: 'C:/repo/zero', route: { harnessId: 'codex' } },
];
const capability = { harnesses: [{ id: 'codex', name: 'Codex', available: true }], bindings: [], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } };
const config = { allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.tasks).mockResolvedValue(tasks);
  vi.mocked(api.capabilities).mockResolvedValue(capability);
  vi.mocked(api.sequences).mockResolvedValue([]);
  vi.mocked(api.config).mockResolvedValue(config as Awaited<ReturnType<typeof api.config>>);
  vi.mocked(api.task).mockImplementation(async id => tasks.find(t => t.id === id)!);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('task workspace', () => {
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
  it('combines list-title search, status, repository and Harness filters in the default table', async () => {
    render(<App />);
    await screen.findByText('修复登录回调');
    expect(screen.getByRole('table')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '登录' } });
    expect(screen.queryByText('更新文档')).toBeNull();
    fireEvent.change(screen.getByLabelText('仓库筛选'), { target: { value: 'C:/repo/zero' } });
    fireEvent.change(screen.getByLabelText('Harness 筛选'), { target: { value: 'codex' } });
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
    fireEvent.click(screen.getAllByRole('button', { name: '提交目标' })[0]!);
    const dialog = screen.getByRole('dialog', { name: '提交有序任务序列' });
    fireEvent.change(within(dialog).getByLabelText(/仓库路径/), { target: { value: 'C:/repo/zero' } });
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
});
