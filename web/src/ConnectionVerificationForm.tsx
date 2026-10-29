import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import type { ConnectionSetup, ConnectionVerification } from './connection-verification';

export function ConnectionVerificationForm({ store }: { store: ConnectionVerification }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [setup, setSetup] = useState<ConnectionSetup | null>(null);
  const [setupError, setSetupError] = useState('');
  const [model, setModel] = useState(state.pending?.modelId ?? state.job?.modelId ?? '');
  const [effort, setEffort] = useState(state.pending?.reasoningEffort ?? state.job?.reasoningEffort ?? 'high');
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => api.connectionSetup({ signal: controller.signal })).then(result => {
      if (!controller.signal.aborted) {
        setSetup(result);
        setModel(current => current || result.codex.models[0]?.id || '');
        setEffort(current => result.codex.reasoningEfforts.includes(current) ? current : result.codex.reasoningEfforts[0] ?? 'high');
      }
    }).catch(error => { if (!controller.signal.aborted) setSetupError(error instanceof Error ? error.message : '无法读取连接选项'); });
    store.resume();
    return () => controller.abort();
  }, [store]);
  const locked = state.busy || !!state.pending;
  const terminal = state.job && !['queued', 'running'].includes(state.job.state);
  const status = state.job?.state;
  const modelValid = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model.trim());
  return <section className="connection-verification" aria-label="接通 Codex 模型">
    <h4>接通模型</h4>
    {setupError && <p role="alert">{setupError}</p>}
    {setup && !setup.codex.available && <p role="status">{setup.codex.reason || 'Codex 运行入口尚不可用，请先安装或配置运行组件。'}</p>}
    <form onSubmit={event => { event.preventDefault(); if (setup?.codex.available && !locked && modelValid) void store.start(model.trim(), effort); }}>
      <div className="connection-model-fields">
        <label>模型<input aria-label="Codex 模型" list="codex-connection-models" value={model} disabled={locked} onChange={event => setModel(event.target.value)} placeholder="输入 Codex 支持的模型标识" required /></label>
        <datalist id="codex-connection-models">{setup?.codex.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</datalist>
        <label>思考强度<select aria-label="Codex 思考强度" value={effort} disabled={locked} onChange={event => setEffort(event.target.value)}>{(setup?.codex.reasoningEfforts ?? ['high']).map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      </div>
      <p>点击将发起一次真实模型验证并使用额度。通过后，Boss 即可使用这个模型。</p>
      {status === 'interrupted' && <p role="status">上次验证的监控已中断，模型可能已执行。再次点击将另外发起调用并使用额度。</p>}
      {status === 'failed' && <p role="alert">{state.job?.error || '验证未通过，请检查模型和登录状态后重试。'}</p>}
      {status === 'succeeded' && <p role="status">{state.job?.modelId} 已通过验证，连接状态正在刷新。</p>}
      {state.pending?.jobId && !state.error && <p role="status">正在验证 {state.pending.modelId}，可以关闭此窗口，稍后回来查看结果。</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {state.uncertain && <p>请求结果尚未确认。重试会沿用原请求标识；原请求未被接收时才会开始验证。</p>}
      {state.pending ? <button type="button" className="button secondary" disabled={state.busy || (!state.error && !!state.pending.jobId)} onClick={() => void store.retry()}>{state.uncertain ? '重试原请求' : state.error ? '重新读取结果' : '验证进行中…'}</button>
        : <button className="button primary" type="submit" disabled={!setup?.codex.available || !modelValid || state.busy}>{terminal && status !== 'succeeded' ? '重新验证并接通' : '验证并接通'}</button>}
    </form>
  </section>;
}
