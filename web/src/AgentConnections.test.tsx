// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AgentConnections } from './AgentConnections';
import type { HarnessHealth } from './types';

afterEach(cleanup);
const agents: HarnessHealth[] = [
  { id: 'codex', name: 'Codex', available: false, reason: 'CLI 可运行，但没有完成真实调用验证的模型绑定' },
  { id: 'dsh', name: 'DSH', available: false, reason: 'Could not start process: spawn dsh ENOENT' },
  { id: 'zcode', name: 'ZCode', available: false, reason: 'Could not start process: spawn zcode ENOENT; ZCode app-server requires an absolute JavaScript CLI entry' },
];
function setup(harnesses: HarnessHealth[] = agents, state: { error?: string; loading?: boolean } = {}) {
  const onRefresh = vi.fn();
  const view = render(<AgentConnections harnesses={harnesses} error={state.error ?? ''} loading={state.loading} onRefresh={onRefresh} />);
  return { ...view, onRefresh };
}
function open() {
  fireEvent.click(screen.getByRole('button', { name: '管理 Agent 连接' }));
  return screen.getByRole('dialog', { name: 'Agent 连接' });
}
function card(dialog: HTMLElement, name: string) {
  return within(dialog).getByText(name).closest('.agent-connection-card')! as HTMLElement;
}

describe('Agent connection management', () => {
  it('keeps the initial connection bar compact and raw technical reasons inside the closed management dialog', () => {
    const { onRefresh } = setup();
    expect(screen.getByRole('button', { name: '管理 Agent 连接' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    for (const agent of agents) expect(screen.queryByText(agent.reason!)).toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();
  });
  it.each([
    { agent: agents[0]!, summary: /待验证模型|模型待验证/ },
    { agent: agents[1]!, summary: /^运行入口不可用$/ },
    { agent: agents[2]!, summary: /^运行入口不可用$/ },
  ])('presents a short Chinese reason and exact original technical detail for $agent.name', ({ agent, summary }) => {
    const { onRefresh } = setup();
    const dialog = open();
    const connection = card(dialog, agent.name);
    expect(within(connection).getByText(summary)).toBeTruthy();
    const technical = within(connection).getByLabelText(`查看 ${agent.name} 技术详情`);
    expect(technical.tagName).toBe('SUMMARY');
    fireEvent.click(technical);
    const details = technical.closest('details')!;
    expect(details.open).toBe(true);
    expect(details.querySelector('p')?.textContent).toBe(agent.reason);
    expect(onRefresh).not.toHaveBeenCalled();
  });
  it.each([{ loading: true, label: '检测中' }, { loading: false, label: '尚未检测' }])(
    'keeps missing capability entries $label instead of claiming all Agents failed', ({ loading, label }) => {
      setup([], { loading });
      const dialog = open();
      for (const name of ['Codex', 'DSH', 'ZCode']) {
        const connection = card(dialog, name);
        expect(within(connection).getByText(label)).toBeTruthy();
        expect(within(connection).queryByText('未找到程序')).toBeNull();
        expect(within(connection).queryByText('未检测到可用配置')).toBeNull();
      }
    },
  );
  it('describes an unclassified failure conservatively instead of guessing a missing executable', () => {
    setup([{ id: 'codex', name: 'Codex', available: false, reason: 'Unexpected adapter diagnostic 741' }]);
    const connection = card(open(), 'Codex');
    expect(within(connection).getByText('连接异常')).toBeTruthy();
    expect(within(connection).queryByText('未找到程序')).toBeNull();
  });
  it('does not claim a program is missing when cliAvailable proves its entry works', () => {
    const recorded = [{ id: 'codex', name: 'Codex', available: false, cliAvailable: true, version: 'fixture-cli', reason: 'Unexpected model binding diagnostic 812' }];
    setup(recorded);
    const connection = card(open(), 'Codex');
    expect(within(connection).getByText(/模型未就绪|模型待验证|待验证模型/)).toBeTruthy();
    expect(within(connection).queryByText('未找到程序')).toBeNull();
    expect(within(connection).queryByText('运行入口不可用')).toBeNull();
  });
  it('does not advertise stale ready Agents when capability refresh has failed', () => {
    setup(agents.map(agent => ({ ...agent, available: true })), { error: 'capability-endpoint-503' });
    expect(screen.getByText('连接状态暂不可用')).toBeTruthy();
    expect(screen.queryByText('可用')).toBeNull();
    const dialog = open();
    for (const agent of agents) expect(within(card(dialog, agent.name)).getByText('状态未知')).toBeTruthy();
    expect(within(dialog).getByText(/capability-endpoint-503/)).toBeTruthy();
  });
  it('refreshes only through the supplied callback and keeps the dialog open', () => {
    const { onRefresh } = setup();
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新连接状态' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Agent 连接' })).toBe(dialog);
  });
  it('uses dialog focus management and restores its opener on Escape', () => {
    setup();
    const opener = screen.getByRole('button', { name: '管理 Agent 连接' });
    opener.focus();
    const dialog = open();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it('links the official Codex App Server explanation without inventing a Desktop connection', () => {
    setup();
    const dialog = open();
    const official = within(dialog).getByRole('link', { name: /Codex App Server/ });
    expect(official.getAttribute('href')).toMatch(/^https:\/\/(developers\.openai\.com|platform\.openai\.com|github\.com\/openai\/codex)\//);
    expect(within(card(dialog, 'Codex')).queryByText('可用')).toBeNull();
    expect(within(dialog).queryByText(/^Codex Desktop 已接入$/)).toBeNull();
  });
  it('renders long multiline technical diagnostics as exact literal text', () => {
    const reason = '  C:\\agent directory\\entry.js\n<script>diagnostic text</script> & <entry>\n最后完整错误原因  ';
    setup([{ id: 'codex', name: 'Codex', available: false, reason }]);
    const dialog = open();
    const summary = within(dialog).getByLabelText('查看 Codex 技术详情');
    fireEvent.click(summary);
    const details = summary.closest('details')!;
    expect(details.querySelector('p')?.textContent).toBe(reason);
    expect(details.querySelector('script')).toBeNull();
    expect(details.querySelector('entry')).toBeNull();
  });
  it('preserves the open modal and technical disclosure across updates, then drops stale failure details on recovery', () => {
    const view = setup();
    const dialog = open();
    const summary = within(dialog).getByLabelText('查看 Codex 技术详情');
    fireEvent.click(summary);
    const details = summary.closest('details')!;
    const freshReason = '刷新后的完整诊断：CLI可用，但模型证明不匹配。';
    view.rerender(<AgentConnections harnesses={agents.map(agent => agent.id === 'codex' ? { ...agent, reason: freshReason } : agent)} error="" onRefresh={view.onRefresh} />);
    expect(screen.getByRole('dialog', { name: 'Agent 连接' })).toBe(dialog);
    expect(within(dialog).getByLabelText('查看 Codex 技术详情').closest('details')).toBe(details);
    expect(details.open).toBe(true);
    expect(details.querySelector('p')?.textContent).toBe(freshReason);
    view.rerender(<AgentConnections harnesses={agents.map(agent => agent.id === 'codex' ? { ...agent, available: true, reason: freshReason } : agent)} error="" onRefresh={view.onRefresh} />);
    const connection = card(dialog, 'Codex');
    expect(within(connection).getByText('可用')).toBeTruthy();
    expect(within(connection).queryByText(freshReason)).toBeNull();
  });
});
