import type { Capabilities, Config, Task, TaskSequence } from './types';

export type RequestOptions = { signal?: AbortSignal };

// Keep uncertain submissions identifiable across retries and reloads in this
// tab. Storage contains a digest and random key, never the submitted task text.
const pendingSubmissions = new Map<string, string>();
function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, normalize(child)])) : item;
  return JSON.stringify(normalize(JSON.parse(JSON.stringify(value))));
}

async function submit<T>(path: string, payload: unknown): Promise<T> {
  const body = stableJson(payload);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${path}\n${body}`));
  const storageKey = `zero.pending-submission.${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  let key = pendingSubmissions.get(storageKey);
  try { key ??= sessionStorage.getItem(storageKey) ?? undefined; } catch { /* Storage can be disabled; in-memory retries still work. */ }
  if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) key = crypto.randomUUID();
  pendingSubmissions.set(storageKey, key);
  try { sessionStorage.setItem(storageKey, key); } catch { /* Keep the in-memory identity. */ }
  const result = await request<T>(path, { method: 'POST', body, headers: { 'X-Idempotency-Key': key } });
  if (pendingSubmissions.get(storageKey) === key) pendingSubmissions.delete(storageKey);
  try { if (sessionStorage.getItem(storageKey) === key) sessionStorage.removeItem(storageKey); } catch { /* Storage can be disabled. */ }
  return result;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    const response = await fetch(path, {
      ...init,
      signal,
      headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    });
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') message = parsed.error;
      } catch { /* Local proxies can return plain-text diagnostics. */ }
      throw new Error(message || `请求失败（${response.status}）`);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } catch (error) {
    if (timeout.aborted && !init?.signal?.aborted) throw new Error('请求超时，请检查 Zero 服务后重试');
    throw error;
  }
}

export const api = {
  capabilities: (options?: RequestOptions) => request<Capabilities>('/api/capabilities', options),
  tasks: (options?: RequestOptions) => request<Task[]>('/api/tasks', options),
  task: (id: string, options?: RequestOptions) => request<Task>(`/api/tasks/${encodeURIComponent(id)}`, options),
  createTask: (payload: unknown) => submit<Task>('/api/tasks', payload),
  sequences: (options?: RequestOptions) => request<TaskSequence[] | { sequences: TaskSequence[] }>('/api/sequences', options),
  sequence: (id: string, options?: RequestOptions) => request<TaskSequence>(`/api/sequences/${encodeURIComponent(id)}`, options),
  createSequence: (payload: unknown) => submit<TaskSequence>('/api/sequences', payload),
  retrySequenceGoalReview: (id: string, attemptId: string) => request<TaskSequence>(`/api/sequences/${encodeURIComponent(id)}/goal-review/retry`, { method: 'POST', body: JSON.stringify({ attemptId }) }),
  cancelTask: (id: string) => request<void>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  config: (options?: RequestOptions) => request<Config>('/api/config', options),
  saveConfig: (config: Config) => request<Config>('/api/config', { method: 'PUT', body: JSON.stringify(config) }),
};
