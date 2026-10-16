import type { Capabilities, Config, Task, TaskSequence } from './types';

export type RequestOptions = { signal?: AbortSignal };

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
  createTask: (payload: unknown) => request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(payload) }),
  sequences: (options?: RequestOptions) => request<TaskSequence[] | { sequences: TaskSequence[] }>('/api/sequences', options),
  sequence: (id: string, options?: RequestOptions) => request<TaskSequence>(`/api/sequences/${encodeURIComponent(id)}`, options),
  createSequence: (payload: unknown) => request<TaskSequence>('/api/sequences', { method: 'POST', body: JSON.stringify(payload) }),
  cancelTask: (id: string) => request<void>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  config: (options?: RequestOptions) => request<Config>('/api/config', options),
  saveConfig: (config: Config) => request<Config>('/api/config', { method: 'PUT', body: JSON.stringify(config) }),
};
