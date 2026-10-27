// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { api } from './api';
vi.mock('./api', () => ({ api: { tasks: vi.fn(), capabilities: vi.fn(), sequences: vi.fn(), config: vi.fn() } }));
afterEach(cleanup);
it('uses the same connection manager from settings without duplicate raw process errors', async () => {
  const reason = 'Could not start process: spawn codex ENOENT';
  vi.mocked(api.tasks).mockResolvedValue([]);
  vi.mocked(api.sequences).mockResolvedValue([]);
  vi.mocked(api.capabilities).mockResolvedValue({ harnesses: [{ id: 'codex', name: 'Codex', available: false, cliAvailable: false, reason }], bindings: [], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } });
  vi.mocked(api.config).mockResolvedValue({ allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } });
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '路由设置' }));
  await screen.findByText('Boss 与团队偏好');
  expect(screen.queryByText(reason)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '管理 Agent 连接' }));
  const dialog = screen.getByRole('dialog', { name: 'Agent 连接' });
  expect(within(dialog).getByLabelText('查看 Codex 技术详情')).toBeTruthy();
});
