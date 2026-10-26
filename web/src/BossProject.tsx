import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowUp, BrainCircuit, CheckCircle2, Copy, Folder, FolderPlus, LoaderCircle, MessageSquare, Send, X } from 'lucide-react';
import { api } from './api';
import { useDialog } from './dialog';
import type { Capabilities, Task } from './types';

const preferenceExample = '例如：Boss 用 Codex gpt6.1sol high，负责设计和验收；具体操作交给便宜模型或 DeepSeek Harness，复杂问题先讨论。';
type FolderListing = Awaited<ReturnType<typeof api.folders>>;

export function ProjectDelivery({ task }: { task: Task }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  useEffect(() => { setCopied(false); setCopyError(''); }, [task.id, task.delivery?.path]);
  const completed = task.status === 'done';
  if (!task.delivery?.path && (!completed || !task.boss)) return null;
  const copyPath = async () => {
    if (!task.delivery?.path) return;
    setCopied(false); setCopyError('');
    try { await navigator.clipboard.writeText(task.delivery.path); setCopied(true); }
    catch { setCopyError('复制未成功，请选中下方路径手动复制。'); }
  };
  return <section className={`project-delivery ${completed ? 'completed' : ''}`} aria-label={completed ? '项目成果' : '任务工作目录'}><div className="project-delivery-heading"><Folder size={19} /><div><h3>{completed ? '项目成果已准备好' : '任务工作目录'}</h3><p>{completed ? '成果保存在下方独立文件夹中，原选文件夹未自动回写。' : 'Agent 在下方独立目录中工作；任务尚未验收完成。'}</p></div></div>{task.delivery?.path ? <><div className="project-delivery-path"><code>{task.delivery.path}</code><button type="button" className="button secondary" onClick={() => void copyPath()}><Copy size={14} />{copied ? '已复制路径' : '复制路径'}</button></div><p className="field-hint">{completed ? '将路径粘贴到电脑文件资源管理器即可查看成果。Zero 不会自动合并、覆盖原目录或推送 GitHub。' : '此路径是实际任务工作区，不是原项目目录。'}</p>{task.delivery.branch && <p className="delivery-version">任务分支：<code>{task.delivery.branch}</code></p>}{task.delivery.resultCommit && <p className="delivery-version">成果提交：<code>{task.delivery.resultCommit}</code></p>}{copied && <span className="sr-only" role="status">成果文件夹路径已复制</span>}{copyError && <p role="alert" className="folder-error">{copyError}</p>}</> : <p className="folder-error">服务端未提供可确认的成果目录。请查看执行报告确认实际路径；原项目目录不能作为成果目录。</p>}</section>;
}

export function BossProjectModal({ capabilities, capabilityError, onClose, onAdvanced, onCreated }: { capabilities: Capabilities | null; capabilityError: string; onClose: () => void; onAdvanced: () => void; onCreated: (task: Task) => void }) {
  const [path, setPath] = useState('');
  const [prompt, setPrompt] = useState('');
  const [preference, setPreference] = useState('');
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState('');
  const [browsePath, setBrowsePath] = useState('');
  const [newName, setNewName] = useState('');
  const folderRequest = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const dialogRef = useDialog(onClose, busy);
  useEffect(() => () => folderRequest.current?.abort(), []);
  const browse = async (target?: string) => {
    folderRequest.current?.abort();
    const controller = new AbortController();
    folderRequest.current = controller;
    setBrowsing(true); setFolderBusy(true); setFolderError('');
    try {
      const result = await api.folders(target, { signal: controller.signal });
      if (!controller.signal.aborted) { setListing(result); setBrowsePath(result.path); setNewName(''); }
    } catch (e) { if (!controller.signal.aborted) setFolderError(e instanceof Error ? e.message : '读取文件夹失败'); }
    finally { if (!controller.signal.aborted) setFolderBusy(false); }
  };
  const closeBrowser = () => { folderRequest.current?.abort(); setBrowsing(false); setFolderBusy(false); };
  const selectFolder = (newFolder = false) => {
    if (!listing) return;
    if (newFolder && (!newName.trim() || /[\\/]/.test(newName) || ['.', '..'].includes(newName.trim()))) { setFolderError('请输入一个文件夹名称，不能包含路径分隔符。'); return; }
    const separator = listing.path.includes('\\') ? '\\' : '/';
    setPath(newFolder ? `${listing.path.replace(/[\\/]$/, '')}${separator}${newName.trim()}` : listing.path);
    setCreate(newFolder); closeBrowser();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || !path.trim() || !prompt.trim()) return;
    submitting.current = true; setBusy(true); setError(''); closeBrowser();
    try {
      const project = await api.prepareProject(path.trim(), create);
      const task = await api.createTask({ repoPath: project.repoPath, prompt: prompt.trim(), boss: { preference: preference.trim() } });
      onCreated(task);
    } catch (e) { setError(e instanceof Error ? e.message : '提交失败，请重试'); }
    finally { submitting.current = false; setBusy(false); }
  };
  const available = capabilities?.bindings.filter(binding => binding.available && capabilities.harnesses.some(h => h.id === binding.harnessId && h.available)) ?? [];
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}><section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="交给 Boss" className="modal submit-modal boss-submit">
    <div className="modal-heading"><div><div className="eyebrow">BOSS / 项目负责人</div><h2>你说目标，Boss 负责推进</h2><p>先设计与讨论，再分配合适的 Agent 和模型，最后检查验收。</p></div><button className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={submit} className="submit-form"><fieldset disabled={busy}>
      <div className="field"><label htmlFor="boss-project-path" className="field-label">项目文件夹 *</label><div className="boss-folder-input"><input id="boss-project-path" required value={path} onChange={e => setPath(e.target.value)} placeholder="选择已有文件夹，或输入新文件夹完整路径" /><button className="button secondary" type="button" onClick={() => void browse(path.trim() || undefined)}><Folder size={15} />浏览文件夹</button></div><span className="field-hint">可使用普通文件夹；Zero 会准备项目版本记录，方便保留和检查改动。</span></div>
      <label className="boss-create-toggle"><input type="checkbox" checked={create} onChange={e => setCreate(e.target.checked)} />这个路径还不存在，创建新文件夹</label>
      {browsing && <section className="folder-browser" aria-label="本机文件夹浏览"><div className="folder-browser-head"><b>选择本机文件夹</b><button type="button" className="icon-button" aria-label="关闭文件夹浏览" onClick={closeBrowser}><X size={15} /></button></div><div className="boss-folder-input"><label className="field"><span className="field-label">浏览路径</span><input value={browsePath} onChange={e => setBrowsePath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void browse(browsePath.trim() || undefined); } }} /></label><button type="button" className="button secondary" disabled={folderBusy} onClick={() => void browse(browsePath.trim() || undefined)}>打开路径</button></div>
        {folderBusy ? <p role="status"><LoaderCircle size={15} className="spin" />正在读取文件夹…</p> : <>{listing?.parent && <button type="button" className="link-button" onClick={() => void browse(listing.parent!)}><ArrowUp size={14} />上一级</button>}{listing && <><p className="folder-current">{listing.path}</p><div className="folder-list">{listing.folders.map(folder => <button type="button" key={folder.path} onClick={() => void browse(folder.path)}><Folder size={15} />{folder.name}</button>)}{!listing.folders.length && <p>此文件夹没有子文件夹，可以直接选择。</p>}</div><div className="folder-browser-actions"><button type="button" className="button primary" onClick={() => selectFolder()}>选择此文件夹</button><label className="field"><span className="field-label">新文件夹名称</span><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="例如 my-project" /></label><button type="button" className="button secondary" disabled={!newName.trim()} onClick={() => selectFolder(true)}><FolderPlus size={15} />使用新文件夹</button></div></>}</>}
        {folderError && <p role="alert" className="folder-error">{folderError}</p>}
      </section>}
      <label className="field"><span className="field-label">你想完成什么 *</span><textarea aria-label="你想完成什么 *" required rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="直接描述目标、背景和需要注意的事项。方案、分工、测试和验收都交给 Boss。" /></label>
      <label className="field"><span className="field-label">Boss 与团队偏好（可选）</span><textarea aria-label="Boss 与团队偏好（可选）" rows={3} value={preference} onChange={e => setPreference(e.target.value)} placeholder={preferenceExample} /><span className="field-hint">用自己的话写即可，模型名称不必准确。Boss 会结合已连接的可用模型判断；留空使用全局 Boss 偏好。</span></label>
      <div className="boss-process"><span><BrainCircuit size={16} />设计与讨论</span><span>→</span><span>跨 Agent 分工</span><span>→</span><span><CheckCircle2 size={16} />检查与验收</span></div>
      {capabilityError ? <div className="inline-warning"><AlertCircle size={15} />能力读取失败：{capabilityError}。请确认服务连接后重试。</div> : capabilities && !available.length ? <div className="inline-warning"><AlertCircle size={15} /><div>尚无已验证的执行组合。请在服务端连接并验证 Codex 或其他 Harness，再刷新能力状态。{capabilities.harnesses.filter(h => !h.available && h.reason).map(h => <p key={h.id}>{h.name}：{h.reason}</p>)}</div></div> : <p className="field-hint">偏好是请求，实际采用的模型、讨论和分工会记录在任务详情中。</p>}
      {error && <div className="alert error compact" role="alert"><AlertCircle size={16} />{error}</div>}
      <div className="modal-footer"><button type="button" className="link-button" disabled={busy} onClick={onAdvanced}>高级模式：手动执行任务</button><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy || !path.trim() || !prompt.trim()}>{busy ? <><LoaderCircle size={15} className="spin" />正在交给 Boss</> : <><Send size={15} />交给 Boss</>}</button></div>
    </fieldset></form>
  </section></div>;
}

export function BossProgress({ task, onMessage }: { task: Task; onMessage: () => void }) {
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const sending = useRef(false);
  const terminal = ['done', 'failed', 'recovery_required'].includes(task.status);
  const canMessage = ['pending', 'running', 'revision', 'waiting'].includes(task.status);
  if (!task.boss && !task.bossPlan && !task.bossMessages?.length) return null;
  const send = async (event: FormEvent) => {
    event.preventDefault(); if (sending.current || !canMessage || !content.trim()) return;
    sending.current = true; setBusy(true); setError(''); setSent(false);
    try { await api.messageTask(task.id, content.trim()); setContent(''); setSent(true); onMessage(); }
    catch (e) { setError(e instanceof Error ? e.message : '发送失败'); }
    finally { sending.current = false; setBusy(false); }
  };
  return <section className="detail-block boss-progress" aria-label="Boss 项目进展"><h3><BrainCircuit size={16} />Boss 项目负责人</h3>{task.boss?.preference && <p className="boss-preference"><b>你的偏好</b><span>{task.boss.preference}</span></p>}
    {task.bossPlan ? <div className="boss-plan"><h4>设计与分工方案</h4><p className="pre-wrap">{task.bossPlan.summary}</p><h4>验收目标</h4><ul>{task.bossPlan.acceptanceCriteria.map((item, i) => <li key={i}>{item}</li>)}</ul><h4>Agent 分工</h4>{task.bossPlan.stages.map((stage, i) => <article key={i} className="boss-plan-stage"><b>{i + 1}. {stage.objective}</b><span>{[stage.harness, stage.model, stage.reasoningEffort].filter(Boolean).join(' · ') || '由 Boss 根据执行时的能力分配'}</span></article>)}<details><summary>Boss 选择的验证方式</summary>{task.bossPlan.checks.map(check => <p key={check.id}><b>{check.id}</b> <code>{check.argv.join(' ')}</code></p>)}</details></div> : <p className="evidence-note">尚未记录 Boss 方案。设计、讨论和分工结果将在这里显示。</p>}
    <h4><MessageSquare size={14} />讨论与补充</h4><div className="boss-message-list">{(task.bossMessages ?? []).map(message => <article key={message.id} className={`boss-message ${message.role}`}><div><b>{message.role === 'user' ? '你' : message.role === 'consultant' ? '参与讨论的 Agent' : 'Boss'}</b><span>{[message.harness, message.model].filter(Boolean).join(' · ')}</span><time>{new Date(message.at).toLocaleString('zh-CN')}</time></div><p>{message.content}</p></article>)}</div>
    <form onSubmit={send}><label className="field"><span className="field-label">给 Boss 补充信息或提问</span><textarea rows={3} maxLength={16000} disabled={busy || !canMessage} value={content} onChange={e => { setContent(e.target.value); setSent(false); }} placeholder="补充要求、说明背景，或提出问题…" /></label><p className="field-hint">{terminal ? '任务已结束，不能追加要求或自动重开。请新建后续任务继续。' : !canMessage ? 'Boss 正在验收本轮结果，暂不能追加要求。请等待验收结束后新建后续任务。' : '消息会保留，Boss 在下一个安全处理点读取，不会打断正在执行的 Agent。'}</p><button className="button secondary" type="submit" disabled={busy || !canMessage || !content.trim()}>{busy ? '正在发送…' : '发送给 Boss'}</button>{sent && <p role="status">消息已保存，等待 Boss 处理。</p>}{error && <p role="alert" className="folder-error">{error}</p>}</form>
  </section>;
}
