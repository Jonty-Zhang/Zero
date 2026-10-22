import { useCallback, useEffect, useRef, useState } from 'react';

/** Each resource polls serially while visible. Manual refresh also works while hidden. */
export function usePolling<T>(key: string | null, load: (key: string, signal: AbortSignal) => Promise<T>, interval = 4500) {
  const [result, setResult] = useState<{ key: string; data: T; at: string } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const lastRefreshRevision = useRef(revision);
  const refresh = useCallback(async () => { setRevision(value => value + 1); }, []);
  useEffect(() => {
    const manual = lastRefreshRevision.current !== revision;
    lastRefreshRevision.current = revision;
    setRefreshing(false);
    if (key === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let refreshOnSettle = false;
    let hidden = document.hidden;
    const controller = new AbortController();
    const update = async () => {
      if (!live || inFlight) return;
      inFlight = true;
      setRefreshing(true);
      try {
        const data = await load(key, controller.signal);
        if (live) { setResult({ key, data, at: new Date().toISOString() }); setFailure(null); }
      } catch (error) {
        if (live) setFailure({ key, message: error instanceof Error ? error.message : '读取失败，请重试' });
      } finally {
        inFlight = false;
        if (live) {
          setRefreshing(false);
          if (!document.hidden) {
            if (refreshOnSettle) { refreshOnSettle = false; void update(); }
            else timer = setTimeout(() => { timer = undefined; if (!document.hidden) void update(); }, interval);
          }
        }
      }
    };
    const visibilityChanged = () => {
      if (hidden === document.hidden) return;
      hidden = document.hidden;
      clearTimeout(timer); timer = undefined;
      if (hidden) { refreshOnSettle = false; return; }
      if (inFlight) refreshOnSettle = true;
      else void update();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    if (!hidden || manual) void update();
    return () => { live = false; controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibilityChanged); };
  }, [key, load, interval, revision]);
  const data = result?.key === key ? result.data : null;
  const error = failure?.key === key ? failure.message : '';
  return { data, error, lastSynced: result?.key === key ? result.at : null, loading: key !== null && !data && !error, refreshing, refresh };
}
