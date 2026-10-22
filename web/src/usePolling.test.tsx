import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePolling } from './usePolling';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function visibility(initial = false) {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(initial);
  return (value: boolean) => { hidden.mockReturnValue(value); document.dispatchEvent(new Event('visibilitychange')); };
}

it('does not start automatic requests while initially hidden and resumes immediately at the original interval', async () => {
  vi.useFakeTimers(); const setHidden = visibility(true);
  const load = vi.fn(async () => 'current');
  const { result } = renderHook(() => usePolling('capabilities', load, 15000));
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(load).not.toHaveBeenCalled();
  await act(async () => setHidden(false));
  expect(load).toHaveBeenCalledTimes(1); expect(result.current.data).toBe('current');
  await act(async () => { await vi.advanceTimersByTimeAsync(14999); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(load).toHaveBeenCalledTimes(2);
});

it('pauses a scheduled automatic poll while hidden but allows a manual refresh', async () => {
  vi.useFakeTimers(); const setHidden = visibility();
  const load = vi.fn(async () => 'current');
  const { result } = renderHook(() => usePolling('tasks', load, 1000));
  await act(async () => {}); expect(load).toHaveBeenCalledTimes(1);
  await act(async () => setHidden(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => result.current.refresh());
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => setHidden(false));
  expect(load).toHaveBeenCalledTimes(3);
});

it('queues one immediate visible refresh after a running request settles without overlapping transports', async () => {
  vi.useFakeTimers(); const setHidden = visibility();
  const resolves: Array<(value: string) => void> = [];
  const load = vi.fn((_key: string, _signal: AbortSignal) => new Promise<string>(resolve => resolves.push(resolve)));
  const { result, unmount } = renderHook(() => usePolling('one', load, 1000));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => { setHidden(true); setHidden(false); setHidden(true); setHidden(false); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => resolves[0]!('first'));
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => resolves[1]!('second'));
  expect(result.current.data).toBe('second');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(load).toHaveBeenCalledTimes(3);
  unmount();
  expect(load.mock.calls[2]?.[1].aborted).toBe(true);
  await act(async () => { setHidden(true); setHidden(false); resolves[2]!('late'); await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(3);
});

it('keeps a manual refresh newer than a transport that ignores abort while the page is hidden', async () => {
  vi.useFakeTimers(); const setHidden = visibility();
  let resolveOld: (value: string) => void = () => {};
  let calls = 0;
  const load = vi.fn((_key: string, _signal: AbortSignal) => ++calls === 1
    ? new Promise<string>(resolve => { resolveOld = resolve; }) : Promise.resolve('manual'));
  const { result } = renderHook(() => usePolling('one', load, 1000));
  await act(async () => setHidden(true));
  await act(async () => result.current.refresh());
  expect(load.mock.calls[0]?.[1].aborted).toBe(true);
  expect(result.current.data).toBe('manual');
  await act(async () => resolveOld('stale'));
  expect(result.current.data).toBe('manual');
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(2);
});

it('does not treat an earlier manual refresh as permission to load a new hidden identity', async () => {
  vi.useFakeTimers(); const setHidden = visibility();
  const load = vi.fn(async (key: string, _signal: AbortSignal) => key);
  const { result, rerender } = renderHook(({ id }) => usePolling(id, load, 1000), { initialProps: { id: 'first' } });
  await act(async () => {});
  await act(async () => result.current.refresh());
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => setHidden(true));
  rerender({ id: 'second' });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(2); expect(result.current.data).toBeNull(); expect(result.current.refreshing).toBe(false);
  await act(async () => setHidden(false));
  expect(load).toHaveBeenCalledTimes(3); expect(result.current.data).toBe('second');
});

it('settling while hidden schedules no timer and visibility events after unmount cannot revive the loop', async () => {
  vi.useFakeTimers(); const setHidden = visibility();
  let resolve: (value: string) => void = () => {};
  const load = vi.fn((_key: string, _signal: AbortSignal) => new Promise<string>(done => { resolve = done; }));
  const { result, unmount } = renderHook(() => usePolling('one', load, 1000));
  await act(async () => setHidden(true));
  await act(async () => resolve('finished while hidden'));
  expect(result.current.data).toBe('finished while hidden');
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  unmount();
  await act(async () => { setHidden(false); await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it('aborts a previous identity and ignores its late response even if the transport ignores cancellation', async () => {
  let resolveFirst: (value: string) => void = () => {};
  const load = vi.fn((key: string, _signal: AbortSignal) => key === 'first' ? new Promise<string>(resolve => { resolveFirst = resolve; }) : Promise.resolve('second evidence'));
  const { result, rerender } = renderHook(({ id }) => usePolling(id, load), { initialProps: { id: 'first' } });
  rerender({ id: 'second' });
  expect(result.current.data).toBeNull();
  expect(load.mock.calls[0]?.[1].aborted).toBe(true);
  await act(async () => {});
  expect(result.current.data).toBe('second evidence');
  await act(async () => resolveFirst('first evidence'));
  expect(result.current.data).toBe('second evidence');
});

it('starts the next poll only after a settled request and stops all future work on unmount', async () => {
  vi.useFakeTimers();
  let resolve: (value: string) => void = () => {};
  const load = vi.fn((_key: string, _signal: AbortSignal) => new Promise<string>(done => { resolve = done; }));
  const { unmount } = renderHook(() => usePolling('one', load, 1000));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => resolve('evidence'));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(load).toHaveBeenCalledTimes(2);
  unmount();
  await act(async () => resolve('late evidence'));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(2);
  expect(load.mock.calls[1]?.[1].aborted).toBe(true);
});
