import { useCallback, useEffect, useState } from 'react';

/** Each resource has one serial poll loop. Cleanup aborts transport and ignores late responses. */
export function usePolling<T>(key: string | null, load: (key: string, signal: AbortSignal) => Promise<T>, interval = 4500) {
  const [result, setResult] = useState<{ key: string; data: T; at: string } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(async () => { setRevision(value => value + 1); }, []);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const update = async () => {
      setRefreshing(true);
      try {
        const data = await load(key, controller.signal);
        if (live) { setResult({ key, data, at: new Date().toISOString() }); setFailure(null); }
      } catch (error) {
        if (live) setFailure({ key, message: error instanceof Error ? error.message : '读取失败，请重试' });
      } finally {
        if (live) { setRefreshing(false); timer = setTimeout(() => void update(), interval); }
      }
    };
    void update();
    return () => { live = false; controller.abort(); clearTimeout(timer); };
  }, [key, load, interval, revision]);
  const data = result?.key === key ? result.data : null;
  const error = failure?.key === key ? failure.message : '';
  return { data, error, lastSynced: result?.key === key ? result.at : null, loading: key !== null && !data && !error, refreshing, refresh };
}
