import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, ChevronRight, Plug, RefreshCw, X } from 'lucide-react';
import { useDialog } from './dialog';
import type { HarnessHealth } from './types';
import { api } from './api';
import { createConnectionVerification, type ConnectionVerification } from './connection-verification';
import { ConnectionVerificationForm } from './ConnectionVerificationForm';

export function newConnectionVerification() {
  let storage: Storage | undefined;
  try { storage = sessionStorage; } catch { /* Browser storage can be disabled. */ }
  return createConnectionVerification({ start: (...args) => api.verifyConnection(...args), read: id => api.connectionVerification(id) }, storage);
}

const agents = [{ id: 'codex', name: 'Codex' }, { id: 'dsh', name: 'DSH' }, { id: 'zcode', name: 'ZCode' }];

function readiness(item: HarnessHealth | undefined, error: string, loading?: boolean) {
  if (error) return { label: '状态未知', hint: '暂时无法读取连接状态，恢复后再刷新。', ready: false };
  if (!item) return { label: loading ? '检测中' : '尚未检测', hint: '还没有收到这个 Agent 的检测结果。', ready: false };
  if (item.available) return { label: '可用', hint: '已有通过验证的模型，可参与任务。', ready: true };
  const unverified = item.reason?.includes('没有完成真实调用验证的模型绑定');
  if (item.cliAvailable || (item.cliAvailable === undefined && unverified)) return {
    label: unverified ? '待验证模型' : '模型未就绪',
    hint: '运行组件已检测到。接通模型后即可交给 Boss 使用。', ready: false,
  };
  if (/\bENOENT\b/.test(item.reason ?? '')) return { label: '运行入口不可用', hint: '检查运行入口路径及工作目录，确认 Zero 能启动这个 Agent。', ready: false };
  if (item.cliAvailable === false) return { label: '运行入口不可用', hint: '运行组件未能启动，具体原因见技术详情。', ready: false };
  return { label: '连接异常', hint: '这个 Agent 暂时不能接收任务，具体原因见技术详情。', ready: false };
}

export function AgentConnections({ harnesses, error, loading, onRefresh, verification }: {
  harnesses: HarnessHealth[]; error: string; loading?: boolean; onRefresh: () => void; verification?: ConnectionVerification;
}) {
  const [open, setOpen] = useState(false);
  const [local] = useState(() => verification ?? newConnectionVerification());
  const store = verification ?? local;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const refreshed = useRef('');
  const refresh = useRef(onRefresh); refresh.current = onRefresh;
  useEffect(() => {
    if (state.job?.state === 'succeeded' && refreshed.current !== state.job.id) {
      refreshed.current = state.job.id;
      refresh.current();
    }
  }, [state.job]);
  const entries = agents.map(agent => {
    const item = harnesses.find(h => h.id.toLowerCase() === agent.id);
    return { ...agent, name: item?.name || agent.name, item, state: readiness(item, error, loading) };
  });
  return <>
    <section className="agent-connections-bar" aria-label="Agent 连接状态">
      <span className="agent-bar-title"><Plug size={17} aria-hidden="true" />Agent</span>
      <div className="agent-bar-statuses">{entries.map(entry => <span className="agent-bar-entry" key={entry.id}>
        <span className={`health-indicator ${entry.state.ready ? 'ok' : 'off'}`} aria-hidden="true" />
        <b>{entry.name}</b><span>{entry.state.label}</span>
      </span>)}</div>
      {error && <span className="agent-bar-error" role="status">连接状态暂不可用</span>}
      <button type="button" className="agent-manage-button" aria-label="管理 Agent 连接" onClick={() => setOpen(true)}>管理连接<ChevronRight size={16} aria-hidden="true" /></button>
    </section>
    {open && <ConnectionDialog entries={entries} error={error} onClose={() => setOpen(false)} onRefresh={onRefresh} verification={store} />}
  </>;
}

function ConnectionDialog({ entries, error, onClose, onRefresh, verification }: {
  entries: Array<{ id: string; name: string; item?: HarnessHealth; state: ReturnType<typeof readiness> }>;
  error: string; onClose: () => void; onRefresh: () => void; verification: ConnectionVerification;
}) {
  const ref = useDialog(onClose);
  return <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={ref} className="modal agent-connections-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-connections-title" tabIndex={-1}>
      <header className="modal-heading"><h2 id="agent-connections-title">Agent 连接</h2><button type="button" className="icon-button" aria-label="关闭 Agent 连接" onClick={onClose}><X size={20} /></button></header>
      <div className="agent-connections-content">
        {error && <div className="agent-connection-error" role="alert"><b>连接状态暂不可用</b><p>{error}</p></div>}
        {entries.map(({ id, name, item, state }) => <article className="agent-connection-card" key={id}>
          <div className="agent-connection-heading"><h3>{name}</h3><span className={`agent-status ${state.ready ? 'ready' : ''}`}>{state.label}</span></div>
          <p className="agent-connection-hint">{state.hint}</p>
          {id === 'codex' && item && <p className="agent-connection-mode">当前接入：本机运行组件（CLI）</p>}
          {id === 'codex' && <ConnectionVerificationForm store={verification} />}
          {!error && item && !state.ready && <details className="agent-technical"><summary aria-label={`查看 ${name} 技术详情`}>技术详情<ChevronRight size={14} aria-hidden="true" /></summary><p>{item.reason || '服务未提供具体原因。'}</p>{item.version && <span className="agent-version">版本：{item.version}</span>}</details>}
        </article>)}
        <aside className="codex-connection-note"><b>Codex 桌面版</b><p>当前版本通过本机运行组件调用 Codex，暂不能接管桌面窗口。App Server 是官方程序化接入协议，尚未在 Zero 启用。</p><a href="https://developers.openai.com/codex/app-server" target="_blank" rel="noreferrer">Codex App Server 文档<ArrowUpRight size={14} aria-hidden="true" /></a></aside>
      </div>
      <footer className="agent-connections-footer"><button type="button" className="button secondary" onClick={onRefresh}><RefreshCw size={16} aria-hidden="true" />刷新连接状态</button><button type="button" className="button primary" onClick={onClose}>完成</button></footer>
    </section>
  </div>;
}
