import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { RichText } from './RichText';
vi.mock('./MarkdownContent', () => { throw new Error('Synthetic parser chunk unavailable'); });
afterEach(cleanup);
it('retains all original text when the optional parser chunk cannot be loaded', async () => {
  const text = '## 方案\n\n**原始要求不能丢失**\n\n```sh\nnpm test\n```';
  const { container } = render(<RichText>{text}</RichText>);
  await act(async () => { await Promise.resolve(); });
  expect(container.querySelector('.rich-text-plain')?.textContent).toBe(text);
});
