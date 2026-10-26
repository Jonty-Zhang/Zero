import { memo, useEffect, useState, type ComponentType } from 'react';

type MarkdownRenderer = ComponentType<{ children: string }>;
let renderer: MarkdownRenderer | undefined;
let loading: Promise<MarkdownRenderer> | undefined;
function loadRenderer() {
  loading ??= import('./MarkdownContent').then(module => (renderer = module.default)).catch(error => { loading = undefined; throw error; });
  return loading;
}

// Keep the initial project list light. Plain text remains readable while the
// parser chunk loads, or when an offline browser cannot retrieve that chunk.
export const RichText = memo(function RichText({ children, className = '' }: { children: string; className?: string }) {
  const [Renderer, setRenderer] = useState<MarkdownRenderer | undefined>(() => renderer);
  useEffect(() => {
    let live = true;
    if (!Renderer) void loadRenderer().then(component => { if (live) setRenderer(() => component); }).catch(() => {});
    return () => { live = false; };
  }, [Renderer, children]);
  return <div className={`rich-text ${className}`}>{Renderer ? <Renderer>{children}</Renderer> : <div className="rich-text-plain">{children}</div>}</div>;
});
