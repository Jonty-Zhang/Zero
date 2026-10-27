// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import App from './App';
import type { Task } from './types';

const draft = '  已经被接收但尚未收到回执的补充要求\n请保留完整实验记录。  ';
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); sessionStorage.clear(); });

function fixture(status: 'reviewing' | 'waiting' | 'running', attempted = true, accepted = true) {
  const taskId = `receipt-${status}-${attempted}`;
  const task: Task = { id: taskId, title: `待确认的${status}项目`, status: 'running', boss: { preference: '' }, bossMessages: [], bossMessageAdmission: 'open' };
  let closed = !attempted;
  const requests: Array<{ path: string; body: string; key: string }> = [];
  const receipts = new Map<string, { id: string; role: string; content: string; at: string }>();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === `/api/tasks/${taskId}/messages`) {
      const headers = new Headers(init?.headers);
      const request = { path, body: String(init?.body), key: headers.get('X-Idempotency-Key')! };
      requests.push(request);
      const payload = JSON.parse(request.body);
      const prior = receipts.get(request.key);
      if (prior) return new Response(JSON.stringify(prior), { status: 201 });
      if (payload.receiptOnly === true) return new Response(JSON.stringify({ error: '没有找到已接收的消息回执；未新增任何要求。' }), { status: 409 });
      if (closed && status === 'running') {
        const accidentallyAdded = { id: 'unwanted-new-message', role: 'user', content: payload.content, at: '2026-10-28T00:01:00.000Z' };
        receipts.set(request.key, accidentallyAdded);
        return new Response(JSON.stringify(accidentallyAdded), { status: 201 });
      }
      if (closed) return new Response(JSON.stringify({ error: '验收已封存，禁止新增要求' }), { status: 409 });
      const receipt = { id: 'accepted-receipt', role: 'user', content: JSON.parse(request.body).content, at: '2026-10-28T00:00:00.000Z' };
      if (accepted) receipts.set(request.key, receipt);
      closed = true;
      throw new Error('请求超时，请检查 Zero 服务后重试');
    }
    let body: unknown;
    if (path === '/api/tasks') body = [task];
    else if (path === `/api/tasks/${taskId}`) body = closed ? { ...task, status, bossMessageAdmission: status === 'running' ? 'open' : 'closed' } : task;
    else if (path === '/api/sequences') body = [];
    else if (path === '/api/capabilities') body = { harnesses: [], bindings: [], allocator: { models: [], reasoningEfforts: [] }, reviewer: { models: [], reasoningEfforts: [] } };
    else if (path === '/api/config') body = { allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } };
    else throw new Error(`Unexpected API ${path}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  return { task, requests, receipts };
}
async function open(task: Task) {
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: task.title! }));
  await act(async () => {});
  return screen.getByRole('dialog', { name: '任务详情' });
}
it.each(['reviewing', 'waiting'] as const)('can confirm an exact accepted-but-timed-out request after real App polling closes %s admission', async status => {
  vi.useFakeTimers();
  const f = fixture(status);
  render(<App />);
  const dialog = await open(f.task);
  const input = within(dialog).getByLabelText('给 Boss 补充信息或提问') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: draft } });
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '发送给 Boss' })); });
  expect(f.receipts.size).toBe(1);
  expect(f.requests).toHaveLength(1);
  expect(within(dialog).getByRole('alert').textContent).toBe('请求超时，请检查 Zero 服务后重试');
  await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
  expect(input.value).toBe(draft);
  expect(input.disabled).toBe(true);
  expect((within(dialog).getByRole('button', { name: '发送给 Boss' }) as HTMLButtonElement).disabled).toBe(true);
  console.log(JSON.stringify({ status, accepted: f.receipts.size, original: f.requests[0], draftPreserved: input.value === draft, buttons: within(dialog).getAllByRole('button').map(button => ({ text: button.textContent, disabled: (button as HTMLButtonElement).disabled })) }));
  const confirm = within(dialog).getByRole('button', { name: '确认发送结果' }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  await act(async () => { fireEvent.click(confirm); });
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.path).toBe(f.requests[0]!.path);
  expect(f.requests[1]!.key).toBe(f.requests[0]!.key);
  expect(JSON.parse(f.requests[1]!.body)).toEqual({ content: draft.trim(), receiptOnly: true });
  expect(f.receipts.size).toBe(1);
  expect(input.value).toBe('');
  expect(within(dialog).getByText('已送达。')).toBeTruthy();
});
it('does not offer a receipt replay for a closed task when no message send was attempted', async () => {
  vi.useFakeTimers();
  const f = fixture('reviewing', false);
  render(<App />);
  const dialog = await open(f.task);
  expect(within(dialog).queryByRole('button', { name: '确认发送结果' })).toBeNull();
  expect((within(dialog).getByRole('button', { name: '发送给 Boss' }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.requests).toHaveLength(0);
  expect(f.receipts.size).toBe(0);
});

it('uses receipt-only confirmation after a task returns to running and does not create a missing receipt', async () => {
  vi.useFakeTimers();
  const f = fixture('running', true, false);
  render(<App />);
  const dialog = await open(f.task);
  const input = within(dialog).getByLabelText('给 Boss 补充信息或提问') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: draft } });
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '发送给 Boss' })); });
  expect(f.requests).toHaveLength(1);
  expect(f.receipts.size).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
  expect(input.value).toBe(draft);
  const confirm = within(dialog).getByRole('button', { name: '确认发送结果' }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  await act(async () => { fireEvent.click(confirm); });
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.path).toBe(f.requests[0]!.path);
  expect(f.requests[1]!.key).toBe(f.requests[0]!.key);
  expect(JSON.parse(f.requests[1]!.body)).toEqual({ content: draft.trim(), receiptOnly: true });
  expect(f.receipts.size).toBe(0);
  expect(input.value).toBe(draft);
  expect(within(dialog).getByRole('alert').textContent).toBe('没有找到已接收的消息回执；未新增任何要求。');
});
