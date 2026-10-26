import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}
describe('readable agent content', () => {
  it('keeps untrusted HTML as text and never creates active unsafe or relative links', () => {
    const { container } = render(<MarkdownContent>{'<script>alert(1)</script>\n\n<img src="https://example.invalid/pixel" onerror="alert(1)">\n\n[unsafe](javascript:alert%281%29) [local](/api/tasks/123/cancel) [data](data:text/html,test) [network](//example.invalid/pixel)'}</MarkdownContent>);
    expect(container.querySelector('script, img, iframe, a[href]')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(screen.getByText('unsafe')).toBeTruthy();
    expect(screen.getByText('local')).toBeTruthy();
  });
  it('opens explicit web references safely without fetching Markdown images', () => {
    const { container } = render(<MarkdownContent>{'[文档](https://example.com/docs)\n\n![方案图](https://example.invalid/tracker.png)'}</MarkdownContent>);
    const link = screen.getByRole('link', { name: '文档' });
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('图片：方案图')).toBeTruthy();
  });
  it('renders tables and read-only task lists, and scopes notes across separate messages', () => {
    const text = '| 项目 | 结果 |\n| --- | --- |\n| 交接 | 正常 |\n\n- [x] 已检查\n- [ ] 待处理\n\n结论[^evidence]\n\n[^evidence]: 原始检查记录';
    const { container } = render(<><MarkdownContent>{text}</MarkdownContent><MarkdownContent>{text}</MarkdownContent></>);
    expect(screen.getAllByRole('table')).toHaveLength(2);
    for (const input of screen.getAllByRole('checkbox')) expect((input as HTMLInputElement).disabled).toBe(true);
    const ids = Array.from(container.querySelectorAll('[id]'), node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const link of container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) expect(document.getElementById(decodeURIComponent(link.hash.slice(1)))).toBeTruthy();
    for (const link of container.querySelectorAll('[aria-describedby]')) expect(document.getElementById(link.getAttribute('aria-describedby')!)).toBeTruthy();
  });
  it('copies fenced code byte for byte while keeping markup literal', async () => {
    const write = clipboard();
    const text = '\tconst literal = "<img src=x onerror=alert(1)>";  \n';
    const { container } = render(<MarkdownContent>{'```ts\n' + text + '```'}</MarkdownContent>);
    expect(container.querySelector('pre code')?.textContent).toBe(text);
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
    await screen.findByText('已复制');
    expect(write).toHaveBeenCalledWith(text);
  });
  it('keeps code selectable after clipboard rejection', async () => {
    clipboard(vi.fn().mockRejectedValue(new Error('denied')));
    const { container } = render(<MarkdownContent>{'```\nnpm test\n```'}</MarkdownContent>);
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
    expect((await screen.findByRole('alert')).textContent).toContain('请选中代码手动复制');
    expect(container.querySelector('pre code')?.textContent).toBe('npm test\n');
  });
  it('does not report a pending copy as success for replacement code', async () => {
    let resolve!: () => void;
    clipboard(vi.fn().mockImplementation(() => new Promise<void>(done => { resolve = done; })));
    const { rerender } = render(<MarkdownContent>{'```sh\nold-command\n```'}</MarkdownContent>);
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
    rerender(<MarkdownContent>{'```sh\nnew-command\n```'}</MarkdownContent>);
    await act(async () => resolve());
    expect(screen.queryByText('已复制')).toBeNull();
    expect(screen.getByRole('button', { name: '复制代码' }).hasAttribute('disabled')).toBe(false);
  });
});
