import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { BossProjectModal } from './BossProject';
import { api } from './api';
import App from './App';
import type { Task } from './types';

const repo = 'C:\\projects\\original';
const sha = 'a'.repeat(40);
const caps = { harnesses: [{ id: 'codex', name: 'Codex', available: true }], bindings: [{ harnessId: 'codex', modelId: 'lead', available: true }], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } };
const draft = () => ({ path: repo, create: false, prompt: 'Continue accepted project', preference: 'Codex leads', pendingSubmission: null, continuation: { repoPath: repo, baseRef: sha } });
const listing = (path: string) => ({ path, parent: null, folders: [] });
function boss() { return render(<BossProjectModal capabilities={caps} capabilityError="" initialDraft={draft()} onClose={vi.fn()} onAdvanced={vi.fn()} onCreated={vi.fn()} />); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it.each([repo.replaceAll('\\', '/'), `${repo}\\`, `${repo}/`])('confirms equivalent Windows path %s before submitting accepted SHA', async path => {
  vi.spyOn(api, 'folders').mockResolvedValue(listing(repo));
  const prepare = vi.spyOn(api, 'prepareProject').mockResolvedValue({ path: repo, repoPath: repo, initialized: false });
  const create = vi.spyOn(api, 'createTask').mockResolvedValue({ id: 'next', status: 'pending' });
  boss();
  fireEvent.change(screen.getByLabelText('项目文件夹 *'), { target: { value: path } });
  await vi.waitFor(() => expect((screen.getByRole('button', { name: '交给 Boss' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0][0]).toMatchObject({ repoPath: repo, baseRef: sha });
  expect(prepare).not.toHaveBeenCalled();
});

it('reuses the original uncertain body and idempotency key after equivalent path confirmation', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(api, 'folders').mockResolvedValue(listing(repo));
  const posts: Array<{ key: string; body: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    posts.push({ key: init.headers['X-Idempotency-Key'], body: init.body });
    throw new Error('accepted but response lost');
  }));
  vi.spyOn(api, 'prepareProject').mockResolvedValue({ path: repo, repoPath: repo, initialized: false });
  boss();
  fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
  await screen.findByText('accepted but response lost');
  fireEvent.change(screen.getByLabelText('项目文件夹 *'), { target: { value: repo.replaceAll('\\', '/') } });
  const retry = await screen.findByRole('button', { name: '确认上次提交' });
  await vi.waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(retry);
  await vi.waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1]).toEqual(posts[0]);
  expect(JSON.parse(posts[1].body)).toMatchObject({ repoPath: repo, baseRef: sha });
});

async function advanced() {
  const done: Task = { id: 'source', title: 'Accepted source', status: 'done', repoPath: repo, prompt: 'Old source goal', boss: { preference: 'Codex leads' }, delivery: { path: 'C:\\accepted-result', branch: 'boss/source', resultCommit: sha } };
  vi.spyOn(api, 'tasks').mockResolvedValue([done]); vi.spyOn(api, 'task').mockResolvedValue(done);
  vi.spyOn(api, 'sequences').mockResolvedValue([]); vi.spyOn(api, 'capabilities').mockResolvedValue(caps);
  vi.spyOn(api, 'config').mockResolvedValue({ allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } });
  vi.spyOn(api, 'connectionSetup').mockResolvedValue({ codex: { available: true, models: [{ id: 'lead', label: 'Lead' }], reasoningEfforts: [] } });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Accepted source' }));
  fireEvent.click(await screen.findByRole('button', { name: '继续这个项目' }));
  fireEvent.change(screen.getByLabelText('你想完成什么 *'), { target: { value: 'Continue accepted project' } });
  fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
  fireEvent.change(screen.getByLabelText(/检查命令/), { target: { value: 'node --version' } });
}

it('advanced configuration confirms the canonical directory and submits the accepted SHA', async () => {
  let resolve!: (value: ReturnType<typeof listing>) => void;
  vi.spyOn(api, 'folders').mockImplementation(() => new Promise(r => { resolve = r; }));
  const create = vi.spyOn(api, 'createTask').mockResolvedValue({ id: 'next', status: 'pending' });
  await advanced();
  fireEvent.change(screen.getByLabelText(/仓库路径/), { target: { value: repo.replaceAll('\\', '/') } });
  expect((screen.getByLabelText('基础分支 / Ref') as HTMLInputElement).value).not.toBe('HEAD');
  expect((screen.getByRole('button', { name: '加入任务队列' }) as HTMLButtonElement).disabled).toBe(true);
  resolve(listing(repo));
  await vi.waitFor(() => expect((screen.getByLabelText('基础分支 / Ref') as HTMLInputElement).value).toBe(sha));
  fireEvent.click(screen.getByRole('button', { name: '加入任务队列' }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0][0]).toMatchObject({ repoPath: repo, baseRef: sha });
});

it.each(['Boss', 'advanced'])('%s blocks form submit during lookup and failure, retries the directory check without creating a task', async mode => {
  let reject!: (error: Error) => void;
  const folders = vi.spyOn(api, 'folders').mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue(listing(repo));
  const prepare = vi.spyOn(api, 'prepareProject');
  const create = vi.spyOn(api, 'createTask').mockResolvedValue({ id: 'next', status: 'pending' });
  if (mode === 'Boss') boss(); else await advanced();
  const pathInput = screen.getByLabelText(mode === 'Boss' ? '项目文件夹 *' : /仓库路径/);
  fireEvent.change(pathInput, { target: { value: `${repo}/` } });
  const submit = screen.getByRole('button', { name: mode === 'Boss' ? '交给 Boss' : '加入任务队列' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.submit(submit.closest('form')!);
  expect(create).not.toHaveBeenCalled();
  reject(new Error('目录暂时不可读'));
  const retry = await screen.findByRole('button', { name: '重试目录检查' });
  expect(submit.disabled).toBe(true);
  fireEvent.submit(submit.closest('form')!);
  expect(create).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await vi.waitFor(() => expect(submit.disabled).toBe(false));
  expect((pathInput as HTMLInputElement).value).toBe(`${repo}/`);
  expect(create).not.toHaveBeenCalled();
  expect(folders).toHaveBeenCalledTimes(2);
  fireEvent.click(submit);
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0][0]).toMatchObject({ repoPath: repo, baseRef: sha });
});

it('restores the original pending payload object after confirmation even if model capabilities disappear', async () => {
  vi.spyOn(api, 'folders').mockResolvedValue(listing(repo));
  const create = vi.spyOn(api, 'createTask').mockRejectedValue(new Error('unknown receipt'));
  const initialDraft = draft();
  const props = { capabilityError: '', initialDraft, onClose: vi.fn(), onAdvanced: vi.fn(), onCreated: vi.fn() };
  const { rerender } = render(<BossProjectModal capabilities={caps} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '交给 Boss' }));
  await screen.findByText('unknown receipt');
  const original = create.mock.calls[0][0];
  rerender(<BossProjectModal capabilities={null} {...props} />);
  fireEvent.change(screen.getByLabelText('项目文件夹 *'), { target: { value: `${repo}/` } });
  const retry = await screen.findByRole('button', { name: '确认上次提交' });
  expect((retry as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(retry);
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls[1][0]).toBe(original);
});
