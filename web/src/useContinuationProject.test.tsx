import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { useContinuationProject } from './useContinuationProject';

const source = { repoPath: 'C:\\projects\\Original', baseRef: 'a'.repeat(40) };
const listing = (path: string) => ({ path, parent: null, folders: [] });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([
  { path: source.repoPath, create: false, source },
  { path: ` ${source.repoPath} `, create: false, source },
  { path: 'C:/projects/Original', create: true, source },
  { path: 'C:/projects/Original', create: false, source: undefined },
  { path: 'C:/projects/Original', create: false, source: { ...source, baseRef: 'HEAD' } },
  { path: 'C:/projects/Original', create: false, source: { ...source, repoPath: '' } },
])('skips directory lookup for direct or ineligible source %#', props => {
  const folders = vi.spyOn(api, 'folders');
  const { result } = renderHook(() => useContinuationProject(props.path, props.create, props.source));
  expect(result.current.resolving).toBe(false);
  expect(folders).not.toHaveBeenCalled();
});

it('uses server identity without case folding and isolates a changed source SHA', async () => {
  const folders = vi.spyOn(api, 'folders').mockResolvedValue(listing('C:\\projects\\original'));
  const { result, rerender } = renderHook(({ commit }) => useContinuationProject('C:/projects/original', false, { ...source, baseRef: commit }), { initialProps: { commit: source.baseRef } });
  await vi.waitFor(() => expect(result.current.resolving).toBe(false));
  expect(result.current).toMatchObject({ repoPath: 'C:\\projects\\original', baseRef: null });
  folders.mockResolvedValue(listing(source.repoPath));
  rerender({ commit: 'b'.repeat(40) });
  expect(result.current).toMatchObject({ resolving: true, baseRef: null });
  await vi.waitFor(() => expect(result.current.baseRef).toBe('b'.repeat(40)));
});

it.each([null, {}, { path: '' }, { path: 'relative' }, { path: 5 },
  { ...listing(source.repoPath), path: `${source.repoPath}\n` },
  { ...listing(source.repoPath), path: `${source.repoPath}\r` },
  { ...listing(source.repoPath), path: ` ${source.repoPath}` },
  listing('\\relative'), { ...listing(source.repoPath), folders: null },
  { ...listing(source.repoPath), folders: [null] }, { ...listing(source.repoPath), parent: 4 },
])('blocks invalid directory responses and permits retry %#', async invalid => {
  const folders = vi.spyOn(api, 'folders').mockResolvedValueOnce(invalid as Awaited<ReturnType<typeof api.folders>>).mockResolvedValue(listing(source.repoPath));
  const { result } = renderHook(() => useContinuationProject('C:/projects/Original', false, source));
  await vi.waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current.baseRef).toBeNull();
  act(() => result.current.retry());
  expect(result.current).toMatchObject({ resolving: true, error: '', baseRef: null });
  await vi.waitFor(() => expect(result.current.baseRef).toBe(source.baseRef));
  expect(folders).toHaveBeenCalledTimes(2);
});

it('aborts and ignores old successes and errors after raw path, source or create changes', async () => {
  const requests: Array<{ resolve: (value: ReturnType<typeof listing>) => void; reject: (error: Error) => void; signal?: AbortSignal }> = [];
  vi.spyOn(api, 'folders').mockImplementation((_path, options) => new Promise((resolve, reject) => { requests.push({ resolve, reject, signal: options?.signal }); }));
  const { result, rerender } = renderHook(props => useContinuationProject(props.path, props.create, props.source), { initialProps: { path: 'C:/projects/Original', create: false, source } });
  rerender({ path: 'C:/elsewhere', create: false, source });
  expect(requests[0].signal?.aborted).toBe(true);
  await act(async () => requests[0].resolve(listing(source.repoPath)));
  expect(result.current).toMatchObject({ resolving: true, baseRef: null, repoPath: 'C:/elsewhere' });
  rerender({ path: 'C:/elsewhere', create: false, source: { ...source, baseRef: 'b'.repeat(40) } });
  await act(async () => requests[1].reject(new Error('old failure')));
  expect(result.current).toMatchObject({ resolving: true, error: '', baseRef: null });
  rerender({ path: 'C:/elsewhere', create: true, source });
  await act(async () => requests[2].resolve(listing(source.repoPath)));
  expect(result.current).toMatchObject({ resolving: false, error: '', baseRef: null, repoPath: 'C:/elsewhere' });
});

it.each([new Error(), new Error('   '), null])('keeps directory failures without usable text blocked %#', async error => {
  vi.spyOn(api, 'folders').mockRejectedValue(error);
  const { result } = renderHook(() => useContinuationProject('C:/projects/Original', false, source));
  await vi.waitFor(() => expect(result.current.error.trim()).not.toBe(''));
  expect(result.current.baseRef).toBeNull();
});

it('blocks network errors until a successful explicit retry', async () => {
  vi.spyOn(api, 'folders').mockRejectedValueOnce(new Error('cannot inspect')).mockResolvedValue(listing(source.repoPath));
  const { result } = renderHook(() => useContinuationProject('C:/projects/Original', false, source));
  await vi.waitFor(() => expect(result.current.error).toBe('cannot inspect'));
  expect(result.current.baseRef).toBeNull();
  act(() => result.current.retry());
  await vi.waitFor(() => expect(result.current.baseRef).toBe(source.baseRef));
});
