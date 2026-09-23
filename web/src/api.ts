import type { Capabilities, Config, Task } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `请求失败（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  capabilities: () => request<Capabilities>('/api/capabilities'),
  tasks: () => request<Task[]>('/api/tasks'),
  task: (id: string) => request<Task>(`/api/tasks/${encodeURIComponent(id)}`),
  createTask: (payload: unknown) => request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(payload) }),
  cancelTask: (id: string) => request<void>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  config: () => request<Config>('/api/config'),
  saveConfig: (config: Config) => request<Config>('/api/config', { method: 'PUT', body: JSON.stringify(config) }),
};
