import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BossProjectModal } from './BossProject';
import { api } from './api';

vi.mock('./api', () => ({ api: { folders: vi.fn(), prepareProject: vi.fn(), createTask: vi.fn() } }));
const capabilities = { harnesses: [{ id: 'codex', name: 'Codex', available: true }], bindings: [{ harnessId: 'codex', modelId: 'verified-model', available: true }], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } };
const oldListing = { path: 'C:/projects/old-parent', parent: 'C:/projects', folders: [{ name: 'old-child', path: 'C:/projects/old-parent/old-child' }] };
const intended = 'C:/projects/intended-parent';
const nextListing = { path: 'C:/canonical/intended-parent', parent: 'C:/canonical', folders: [] };
const original = { path: 'C:/projects/original-project', prompt: '完成原始目标', preference: '保留原始偏好', create: false, pendingSubmission: null };
function open(initialDraft: NonNullable<Parameters<typeof BossProjectModal>[0]['initialDraft']> = original, onAdvanced = vi.fn()) {
  render(<BossProjectModal capabilities={capabilities} capabilityError="" initialDraft={initialDraft} onClose={vi.fn()} onAdvanced={onAdvanced} onCreated={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '浏览文件夹' }));
  return screen.getByLabelText('浏览路径') as HTMLInputElement;
}
function expectNoSubmission() {
  expect(api.prepareProject).not.toHaveBeenCalled();
  expect(api.createTask).not.toHaveBeenCalled();
}
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

it('preserves a newer typed destination when the previous folder request resolves ignoring abort', async () => {
  let resolve!: (listing: typeof oldListing) => void;
  vi.mocked(api.folders).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const address = open();
  fireEvent.change(address, { target: { value: intended } });
  await act(async () => resolve(oldListing));
  expect(address.value).toBe(intended);
  expect(screen.queryByRole('button', { name: '选择此文件夹' })).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  expectNoSubmission();
});

it.each(['existing folder', 'new folder button', 'new folder Enter'])('invalidates the old target on address edit before %s', async mode => {
  vi.mocked(api.folders).mockResolvedValueOnce(oldListing).mockResolvedValueOnce(nextListing);
  const address = open();
  const oldChoose = await screen.findByRole('button', { name: '选择此文件夹' });
  const oldName = screen.getByLabelText('新文件夹名称');
  fireEvent.change(oldName, { target: { value: 'old-name' } });
  const oldNew = screen.getByRole('button', { name: '使用新文件夹' });
  fireEvent.change(address, { target: { value: intended } });
  // Exercise any still-visible old controls without requiring them to remain rendered.
  if (document.contains(oldChoose) && mode === 'existing folder') fireEvent.click(oldChoose);
  if (document.contains(oldName) && mode === 'new folder Enter') fireEvent.keyDown(oldName, { key: 'Enter' });
  if (document.contains(oldNew) && mode === 'new folder button') fireEvent.click(oldNew);
  expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe(original.path);
  expect(screen.getByLabelText('本机文件夹浏览')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'old-child' })).toBeNull();
  expect(screen.queryByRole('button', { name: '选择此文件夹' })).toBeNull();
  expect(screen.queryByLabelText('新文件夹名称')).toBeNull();
  expectNoSubmission();

  fireEvent.click(screen.getByRole('button', { name: '打开路径' }));
  await screen.findByRole('button', { name: '选择此文件夹' });
  expect(api.folders).toHaveBeenLastCalledWith(intended, { signal: expect.any(AbortSignal) });
  expect(address.value).toBe(nextListing.path);
  expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe('');
  if (mode === 'existing folder') fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }));
  else {
    const name = screen.getByLabelText('新文件夹名称');
    fireEvent.change(name, { target: { value: 'new-project' } });
    if (mode === 'new folder Enter') fireEvent.keyDown(name, { key: 'Enter' });
    else fireEvent.click(screen.getByRole('button', { name: '使用新文件夹' }));
  }
  expect((screen.getByLabelText('项目文件夹 *') as HTMLInputElement).value).toBe(nextListing.path + (mode === 'existing folder' ? '' : '/new-project'));
  expect((screen.getByLabelText('这个路径还不存在，创建新文件夹') as HTMLInputElement).checked).toBe(mode !== 'existing folder');
  expectNoSubmission();
});

it.each(['success', 'failure'])('ignores old %s and finally while the newly confirmed folder is loading', async outcome => {
  let resolveOld!: (listing: typeof oldListing) => void;
  let rejectOld!: (error: Error) => void;
  let resolveNew!: (listing: typeof nextListing) => void;
  vi.mocked(api.folders).mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
  const address = open();
  const signal = vi.mocked(api.folders).mock.calls[0]![1]!.signal!;
  fireEvent.change(address, { target: { value: intended } });
  expect(signal.aborted).toBe(true);
  expect((screen.getByRole('button', { name: '打开路径' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.keyDown(address, { key: 'Enter', code: 'Enter' });
  await act(async () => { if (outcome === 'success') resolveOld(oldListing); else rejectOld(new Error('stale failure')); });
  expect(address.value).toBe(intended);
  expect(screen.getByRole('status').textContent).toContain('正在读取文件夹');
  expect((screen.getByRole('button', { name: '打开路径' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => resolveNew(nextListing));
  expect(address.value).toBe(nextListing.path);
  expect(screen.getByRole('button', { name: '选择此文件夹' })).toBeTruthy();
  expectNoSubmission();
});

it('clears an old error when editing and reopens an empty address through the API', async () => {
  vi.mocked(api.folders).mockRejectedValueOnce(new Error('old error')).mockResolvedValueOnce(nextListing);
  const address = open();
  await screen.findByRole('alert');
  fireEvent.change(address, { target: { value: '' } });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(address.value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: '打开路径' }));
  await screen.findByRole('button', { name: '选择此文件夹' });
  expect(api.folders).toHaveBeenLastCalledWith(undefined, { signal: expect.any(AbortSignal) });
  expect(address.value).toBe(nextListing.path);
  expectNoSubmission();
});

it('retains the project draft and uncertain submission identity across address editing', async () => {
  const pendingSubmission = { draftKey: 'original-identity', payload: { repoPath: original.path, prompt: original.prompt, boss: { preference: original.preference } } };
  const initialDraft = { ...original, pendingSubmission };
  const onAdvanced = vi.fn();
  vi.mocked(api.folders).mockResolvedValueOnce(oldListing);
  const address = open(initialDraft, onAdvanced);
  await screen.findByLabelText('新文件夹名称');
  fireEvent.change(address, { target: { value: intended } });
  fireEvent.click(screen.getByRole('button', { name: '关闭文件夹浏览' }));
  fireEvent.click(screen.getByRole('button', { name: '手动配置' }));
  expect(onAdvanced).toHaveBeenCalledWith(initialDraft);
  expect(onAdvanced.mock.calls[0]![0].pendingSubmission).toBe(pendingSubmission);
  expectNoSubmission();
});
