import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowUp, Copy, Folder, FolderPlus, LoaderCircle, MessageSquare, Send, X } from 'lucide-react';
import { api } from './api';
import { RichText } from './RichText';
import { TaskLead } from './TaskLead';
import { useDialog } from './dialog';
import type { Capabilities, Task } from './types';
import { createBossMessageComposer, useBossMessageComposer, type BossMessageComposer } from './boss-message-composer';

const preferenceExample = 'Codex gpt6.1sol high 负责设计与验收，日常实现交给便宜模型或 DeepSeek，复杂问题先讨论。';
type FolderListing = Awaited<ReturnType<typeof api.folders>>;
type BossSubmission = { draftKey: string; payload: { repoPath: string; prompt: string; boss: { preference: string } } };
export type BossProjectDraft = { path: string; prompt: string; preference: string; create: boolean; pendingSubmission: BossSubmission | null };

export function ProjectDelivery({ task }: { task: Task }) {
  const scope = JSON.stringify([task.id, task.delivery?.path ?? null]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const pendingCopy = useRef<{ scope: string } | null>(null);
  const [feedback, setFeedback] = useState<{ scope: string; status: 'copying' | 'copied' | 'failed' } | null>(null);
  useEffect(() => {
    pendingCopy.current = null;
    setFeedback(null);
    return () => { pendingCopy.current = null; };
  }, [scope]);
  const copying = feedback?.scope === scope && feedback.status === 'copying';
  const copied = feedback?.scope === scope && feedback.status === 'copied';
  const copyFailed = feedback?.scope === scope && feedback.status === 'failed';
  const completed = task.status === 'done';
  if (!task.delivery?.path && (!completed || !task.boss)) return null;
  const copyPath = async () => {
    if (!task.delivery?.path || pendingCopy.current?.scope === scope) return;
    const request = { scope };
    pendingCopy.current = request;
    setFeedback({ scope, status: 'copying' });
    const isCurrent = () => pendingCopy.current === request && currentScope.current === scope;
    try {
      await navigator.clipboard.writeText(task.delivery.path);
      if (isCurrent()) setFeedback({ scope, status: 'copied' });
    } catch {
      if (isCurrent()) setFeedback({ scope, status: 'failed' });
    } finally {
      if (pendingCopy.current === request) pendingCopy.current = null;
    }
  };
  return <section className={`project-delivery ${completed ? 'completed' : ''}`} aria-label={completed ? '项目成果' : '任务工作目录'}>
    <div className="project-delivery-heading"><Folder size={18} /><div><h3>{completed ? '项目成果' : '工作目录'}</h3><p>{completed ? '独立成果目录，原选文件夹未自动回写。' : '独立工作区，尚未验收。'}</p></div></div>
    {task.delivery?.path ? <>
      <div className="project-delivery-path"><code>{task.delivery.path}</code><button type="button" className="button secondary" disabled={copying} aria-busy={copying} onClick={() => void copyPath()}>{copying ? <LoaderCircle size={14} className="spin" /> : <Copy size={14} />}{copying ? '复制中…' : copied ? '已复制路径' : '复制路径'}</button></div>
      {completed && <p className="delivery-note">不会自动合并或推送 GitHub。</p>}
      {(task.delivery.branch || task.delivery.resultCommit) && <dl className="delivery-version-list">
        {task.delivery.branch && <div><dt>分支</dt><dd><code>{task.delivery.branch}</code></dd></div>}
        {task.delivery.resultCommit && <div><dt>提交</dt><dd><code>{task.delivery.resultCommit}</code></dd></div>}
      </dl>}
      {copied && <span className="sr-only" role="status">成果文件夹路径已复制</span>}
      {copyFailed && <p role="alert" className="folder-error">复制未成功，请选中下方路径手动复制。</p>}
    </> : <p className="folder-error">成果目录尚未确认，请查看执行报告。</p>}
  </section>;
}

export function BossProjectModal({ capabilities, capabilityError, initialDraft, onClose, onAdvanced, onCreated }: { capabilities: Capabilities | null; capabilityError: string; initialDraft?: BossProjectDraft | null; onClose: () => void; onAdvanced: (draft: BossProjectDraft) => void; onCreated: (task: Task) => void }) {
  const [path, setPath] = useState(initialDraft?.path ?? '');
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? '');
  const [preference, setPreference] = useState(initialDraft?.preference ?? '');
  const [create, setCreate] = useState(initialDraft?.create ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState('');
  const [browsePath, setBrowsePath] = useState('');
  const [newName, setNewName] = useState('');
  const [pendingSubmission, setPendingSubmission] = useState<BossSubmission | null>(initialDraft?.pendingSubmission ?? null);
  const folderRequest = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const dialogRef = useDialog(onClose, busy);
  const codex = capabilities?.harnesses.find(harness => harness.id === 'codex');
  const leadReady = !capabilityError && !!codex?.available && !!capabilities?.bindings.some(binding => binding.harnessId === 'codex' && binding.available);
  const draftKey = JSON.stringify([path.trim(), create, prompt.trim(), preference.trim()]);
  const retrySubmission = pendingSubmission?.draftKey === draftKey ? pendingSubmission : null;
  const submissionReady = leadReady || !!retrySubmission;
  useEffect(() => () => folderRequest.current?.abort(), []);
  const browse = async (target?: string) => {
    folderRequest.current?.abort();
    const controller = new AbortController();
    folderRequest.current = controller;
    setBrowsing(true); setFolderBusy(true); setFolderError('');
    setListing(null); setNewName(''); setBrowsePath(target ?? '');
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
    if (submitting.current || browsing || !submissionReady || !path.trim() || !prompt.trim()) return;
    submitting.current = true; setBusy(true); setError(''); closeBrowser();
    try {
      let submission = retrySubmission;
      if (!submission) {
        const project = await api.prepareProject(path.trim(), create);
        submission = { draftKey, payload: { repoPath: project.repoPath, prompt: prompt.trim(), boss: { preference: preference.trim() } } };
        setPendingSubmission(submission);
      }
      const task = await api.createTask(submission.payload);
      setPendingSubmission(null);
      onCreated(task);
    } catch (e) { setError(e instanceof Error ? e.message : '提交失败，请重试'); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}><section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="交给 Boss" className="modal submit-modal boss-submit">
    <div className="modal-heading boss-project-heading"><h2>新建项目</h2><button className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={submit} className="submit-form"><fieldset disabled={busy}>
      <div className="field"><label htmlFor="boss-project-path" className="field-label">项目文件夹 *</label><div className="boss-folder-input"><input id="boss-project-path" required value={path} onChange={e => setPath(e.target.value)} placeholder="选择文件夹或输入完整路径" /><button className="button secondary" type="button" onClick={() => void browse(path.trim() || undefined)}><Folder size={15} />浏览文件夹</button></div><span className="field-hint">支持普通文件夹，无需预先配置 Git。</span></div>
      <label className="boss-create-toggle"><input type="checkbox" checked={create} onChange={e => setCreate(e.target.checked)} />这个路径还不存在，创建新文件夹</label>
      {browsing && <section className="folder-browser" aria-label="本机文件夹浏览"><div className="folder-browser-head"><b>选择本机文件夹</b><button type="button" className="icon-button" aria-label="关闭文件夹浏览" onClick={closeBrowser}><X size={15} /></button></div><div className="boss-folder-input"><label className="field"><span className="field-label">浏览路径</span><input value={browsePath} onChange={e => setBrowsePath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void browse(browsePath.trim() || undefined); } }} /></label><button type="button" className="button secondary" disabled={folderBusy} onClick={() => void browse(browsePath.trim() || undefined)}>打开路径</button></div>
        {folderBusy ? <p role="status"><LoaderCircle size={15} className="spin" />正在读取文件夹…</p> : <>{listing?.parent && <button type="button" className="link-button" onClick={() => void browse(listing.parent!)}><ArrowUp size={14} />上一级</button>}{listing && <><p className="folder-current">{listing.path}</p><div className="folder-list">{listing.folders.map(folder => <button type="button" key={folder.path} onClick={() => void browse(folder.path)}><Folder size={15} />{folder.name}</button>)}{!listing.folders.length && <p>没有子文件夹</p>}</div><div className="folder-browser-actions"><button type="button" className="button primary" onClick={() => selectFolder()}>选择此文件夹</button><label className="field"><span className="field-label">新文件夹名称</span><input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); selectFolder(true); } }} placeholder="例如 my-project" /></label><button type="button" className="button secondary" disabled={!newName.trim()} onClick={() => selectFolder(true)}><FolderPlus size={15} />使用新文件夹</button></div></>}</>}
        {folderError && <p role="alert" className="folder-error">{folderError}</p>}
      </section>}
      <label className="field"><span className="field-label">你想完成什么 *</span><textarea aria-label="你想完成什么 *" required rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述目标、背景和约束。方案、分工与验收由负责人处理。" /></label>
      <label className="field"><span className="field-label">Boss 与团队偏好（可选）</span><textarea aria-label="Boss 与团队偏好（可选）" rows={3} value={preference} onChange={e => setPreference(e.target.value)} placeholder={preferenceExample} /><span className="field-hint">模型名称不必准确；留空使用默认偏好。</span></label>
      {capabilityError ? <div className="inline-warning"><AlertCircle size={15} />无法读取可用模型：{capabilityError}。请重试，草稿已保留。</div> : !capabilities ? <p className="field-hint" role="status">正在确认 Codex 是否可用…</p> : !leadReady ? <div className="inline-warning"><AlertCircle size={15} /><div>尚无可用的 Codex 项目负责人。请先连接并验证 Codex 模型，再刷新。{codex?.reason && <p>Codex：{codex.reason}</p>}</div></div> : null}
      {retrySubmission && !busy && <p className="field-hint">上次提交结果未确认。重试不会重复创建任务。</p>}
      {error && <div className="alert error compact" role="alert"><AlertCircle size={16} />{error}</div>}
      <div className="modal-footer"><button type="button" className="link-button" disabled={busy} onClick={() => onAdvanced({ path, prompt, preference, create, pendingSubmission })}>手动配置</button><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy || browsing || !submissionReady || !path.trim() || !prompt.trim()}>{busy ? <><LoaderCircle size={15} className="spin" />正在交给 Boss</> : <><Send size={15} />{retrySubmission ? '确认上次提交' : '交给 Boss'}</>}</button></div>
    </fieldset></form>
  </section></div>;
}

export function BossProgress({ task, onMessage, composer }: { task: Task; onMessage: (taskId: string) => void; composer?: BossMessageComposer }) {
  const [localComposer] = useState(() => createBossMessageComposer({ send: api.messageTask, confirm: api.confirmMessageTask }));
  const messageComposer = composer ?? localComposer;
  const { content, busy, error, sent, canConfirm } = useBossMessageComposer(messageComposer, task.id);
  const terminal = ['done', 'failed', 'recovery_required'].includes(task.status);
  const canMessage = ['pending', 'running', 'revision', 'waiting'].includes(task.status) && task.bossMessageAdmission !== 'closed';
  if (!task.boss && !task.bossPlan && !task.bossMessages?.length) return null;
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!canMessage) return;
    const delivered = await messageComposer.send(task.id, { allowed: canMessage });
    if (delivered) {
      try { onMessage(task.id); } catch { /* A refresh failure cannot revoke a confirmed receipt. */ }
    }
  };
  const confirm = async () => {
    const delivered = await messageComposer.confirm(task.id);
    if (delivered) {
      try { onMessage(task.id); } catch { /* Confirmation already succeeded. */ }
    }
  };
  return <section className="detail-block boss-progress" aria-label="Boss 项目进展">
    <div className="boss-section-heading"><h3>项目方案</h3>{task.boss?.preference && <details className="boss-preference"><summary>团队偏好</summary><p>{task.boss.preference}</p></details>}</div>
    <TaskLead task={task} />
    {task.bossPlan ? <div className="boss-plan">
      <RichText className="boss-plan-summary">{task.bossPlan.summary}</RichText>
      <div className="boss-plan-grid">
        <section className="boss-acceptance"><h4>验收标准</h4><ul>{task.bossPlan.acceptanceCriteria.map((item, i) => <li key={i}>{item}</li>)}</ul></section>
        <section className="boss-assignments"><h4>分工</h4><div className="boss-stage-list">{task.bossPlan.stages.map((stage, i) => <article key={i} className="boss-plan-stage"><span className="boss-stage-index" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span><div><h5>{stage.objective}</h5><p className="boss-stage-route">{[stage.harness, stage.model, stage.reasoningEffort].filter(Boolean).join(' · ') || '待分配'}</p></div></article>)}</div></section>
      </div>
      <details className="boss-validation"><summary>验证命令</summary><ul>{task.bossPlan.checks.map(check => <li key={check.id}><span>{check.id}</span><code>{check.argv.join(' ')}</code></li>)}</ul></details>
    </div> : <p className="boss-plan-empty">方案尚未生成。</p>}
    <section className="boss-discussion" aria-label="项目讨论"><h4><MessageSquare size={15} />讨论</h4>
      <div className="boss-message-list">{(task.bossMessages ?? []).map(message => <article key={message.id} className={`boss-message ${message.role}`}><header className="boss-message-meta"><b>{message.role === 'user' ? '你' : message.role === 'consultant' ? '顾问' : 'Boss'}</b><span>{[message.harness, message.model].filter(Boolean).join(' · ')}</span><time dateTime={message.at} title={new Date(message.at).toLocaleString('zh-CN')}>{new Date(message.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></header><RichText>{message.content}</RichText></article>)}</div>
      <form onSubmit={send} className="boss-message-form" aria-disabled={!canMessage && !canConfirm}>
        <label className="field"><span className="field-label">给 Boss 补充信息或提问</span><textarea rows={3} maxLength={16000} disabled={busy || !canMessage} value={content} onChange={e => messageComposer.setContent(task.id, e.target.value)} placeholder="补充要求或提问…" /></label>
        <div className="boss-message-actions"><p className="boss-message-status">{canConfirm ? '可确认上一条消息是否送达，确认不会追加要求。' : terminal ? '任务已结束。继续工作请新建后续任务。' : !canMessage ? (task.status === 'waiting' ? '验收已暂停，要求已封存。新要求请新建后续任务。' : '正在验收。新要求请在验收后新建后续任务。') : '消息将在下个安全处理点读取。'}</p>{canConfirm && <button className="button secondary" type="button" disabled={busy} onClick={() => void confirm()}>确认发送结果</button>}<button className="button secondary" type="submit" disabled={busy || !canMessage || !content.trim()}>{busy ? '发送中…' : '发送给 Boss'}<Send size={14} /></button></div>
        {sent && <p role="status" className="boss-message-receipt">已送达。</p>}{error && <p role="alert" className="folder-error">{error}</p>}
      </form>
    </section>
  </section>;
}
