import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BossProgress } from './BossProject';
import { api } from './api';
import type { Task } from './types';

vi.mock('./api', () => ({ api: { messageTask: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('preserves the draft and closes sending when polling reports frozen acceptance during a quota wait', () => {
  const task: Task = { id: 'boss-quota', status: 'running', boss: { preference: '' }, bossMessageAdmission: 'open' };
  const { rerender } = render(<BossProgress task={task} onMessage={vi.fn()} />);
  const input = screen.getByLabelText('给 Boss 补充信息或提问') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '尚未发送的补充要求' } });
  const form = screen.getByRole('button', { name: '发送给 Boss' }).closest('form')!;
  rerender(<BossProgress task={{ ...task, status: 'waiting', bossMessageAdmission: 'closed' }} onMessage={vi.fn()} />);
  expect(input.value).toBe('尚未发送的补充要求');
  expect(input.disabled).toBe(true);
  expect((screen.getByRole('button', { name: '发送给 Boss' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/验收已暂停/)).toBeTruthy();
  fireEvent.submit(form);
  expect(api.messageTask).not.toHaveBeenCalled();
  rerender(<BossProgress task={{ ...task, status: 'waiting', bossMessageAdmission: 'open' }} onMessage={vi.fn()} />);
  expect(input.disabled).toBe(false);
  expect(input.value).toBe('尚未发送的补充要求');
});
