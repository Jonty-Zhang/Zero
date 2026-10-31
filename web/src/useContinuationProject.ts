import { useEffect, useState } from 'react';
import { api } from './api';

type Source = { repoPath: string; baseRef: string } | undefined;
type Confirmation = { key: string; repoPath?: string; error?: string };

// Only the server's realpath result can establish an edited path's identity.
export function useContinuationProject(path: string, create: boolean, source: Source) {
  const rawPath = path.trim();
  const validSource = !!source?.repoPath.trim() && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(source?.baseRef ?? '');
  const needsConfirmation = validSource && !create && rawPath !== source!.repoPath.trim();
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([path, create, source?.repoPath, source?.baseRef, attempt]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  useEffect(() => {
    if (!needsConfirmation) return;
    const controller = new AbortController();
    let live = true;
    void (async () => {
      try {
        // Empty input must not turn into folders()'s default-directory lookup.
        if (!rawPath) throw new Error('请填写项目文件夹路径');
        const result = await api.folders(rawPath, { signal: controller.signal });
        if (!result || typeof result.path !== 'string' || !result.path.trim() || result.path !== result.path.trim()
          || !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(result.path) || /[\0\r\n]/.test(result.path)
          || !(result.parent === null || typeof result.parent === 'string') || !Array.isArray(result.folders)
          || !result.folders.every(folder => folder && typeof folder.name === 'string' && typeof folder.path === 'string')) {
          throw new Error('目录检查返回了无效路径');
        }
        if (live) setConfirmation({ key, repoPath: result.path.trim() });
      } catch (error) {
        if (live) setConfirmation({ key, error: error instanceof Error && error.message.trim() ? error.message : '目录检查失败' });
      }
    })();
    return () => { live = false; controller.abort(); };
  }, [key, needsConfirmation, rawPath]);
  const current = confirmation?.key === key ? confirmation : null;
  const resolving = needsConfirmation && !current;
  const error = needsConfirmation ? current?.error ?? '' : '';
  const repoPath = needsConfirmation ? current?.repoPath ?? rawPath : rawPath;
  const baseRef = validSource && !create && !resolving && !error && repoPath === source!.repoPath.trim() ? source!.baseRef : null;
  return { repoPath, baseRef, resolving, error, retry: () => setAttempt(value => value + 1) };
}
