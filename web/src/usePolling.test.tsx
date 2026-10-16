import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePolling } from './usePolling';

afterEach(() => { cleanup(); vi.useRealTimers(); });

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
