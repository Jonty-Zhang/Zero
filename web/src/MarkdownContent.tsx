import { Children, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

type HtmlNode = { properties?: Record<string, unknown>; children?: HtmlNode[] };
function scopeFootnoteLabel({ prefix }: { prefix: string }) {
  return (tree: HtmlNode) => {
    const visit = (node: HtmlNode) => {
      const props = node.properties;
      if (props?.id === 'footnote-label') props.id = `${prefix}footnote-label`;
      if (Array.isArray(props?.ariaDescribedBy)) props.ariaDescribedBy = props.ariaDescribedBy.map(value => value === 'footnote-label' ? `${prefix}footnote-label` : value);
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(child => isValidElement<{ children?: string; className?: string }>(child));
  const text = isValidElement<{ children?: string }>(code) && typeof code.props.children === 'string' ? code.props.children : '';
  const className = isValidElement<{ className?: string }>(code) ? code.props.className : '';
  const language = className?.match(/\blanguage-([\w+-]{1,24})\b/)?.[1];
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const operation = useRef(0);
  const copying = useRef(false);
  useEffect(() => {
    operation.current++; copying.current = false; setCopied(false); setError(false); setBusy(false);
    return () => { operation.current++; };
  }, [text]);
  const copy = async () => {
    if (copying.current) return;
    copying.current = true; const current = ++operation.current;
    setCopied(false); setError(false); setBusy(true);
    try { await navigator.clipboard.writeText(text); if (operation.current === current) setCopied(true); }
    catch { if (operation.current === current) setError(true); }
    finally { if (operation.current === current) { copying.current = false; setBusy(false); } }
  };
  return <div className="rich-code"><div className="rich-code-heading"><span>{language || '代码'}</span><button type="button" disabled={busy} className="code-copy" aria-label="复制代码" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{busy ? '复制中…' : copied ? '已复制' : '复制'}</button></div><pre tabIndex={0}>{children}</pre>{error && <p className="code-copy-error" role="alert">复制未成功，请选中代码手动复制。</p>}</div>;
}

const components: Components = {
  h1: ({ node: _node, ...props }) => <h4 {...props} />,
  h2: ({ node: _node, ...props }) => <h4 {...props} />,
  h3: ({ node: _node, ...props }) => <h5 {...props} />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => <div className="rich-table-scroll" role="region" aria-label="内容表格" tabIndex={0}><table>{children}</table></div>,
  // Images supplied by an agent must not trigger third-party requests on view.
  img: ({ alt }) => <span className="rich-image-label">图片：{alt || '未命名图片'}</span>,
  a: ({ node: _node, href, children, ...props }) => {
    const external = /^https?:\/\//i.test(href || '');
    const allowed = external || /^(mailto:|#)/i.test(href || '');
    return allowed ? <a {...props} href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>{children}</a> : <span>{children}</span>;
  },
};

export default function MarkdownContent({ children }: { children: string }) {
  const id = useId().replaceAll(':', '');
  const prefix = `zero-note-${id}-`;
  return <Markdown components={components} remarkPlugins={[remarkGfm]} rehypePlugins={[[scopeFootnoteLabel, { prefix }]]} remarkRehypeOptions={{ clobberPrefix: prefix, footnoteLabel: '注释', footnoteBackLabel: '返回引用位置' }}>{children}</Markdown>;
}
