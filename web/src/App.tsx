import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, AlertCircle, ArrowDown, ArrowRight, ArrowUp, Check, CheckCircle2, ChevronDown, CircleHelp, Clock3, Code2, FileText, FolderGit2, LoaderCircle, Plus, RefreshCw, Settings2, ShieldCheck, TerminalSquare, X, XCircle } from 'lucide-react';
import { api } from './api';
import type { Binding, Capabilities, Choice, Config, HarnessHealth, Status, Task, TestResult } from './types';

const columns: { id: Status; label: string; tone: string }[] = [
  { id: 'pending', label: '待处理', tone: 'slate' }, { id: 'running', label: '执行中', tone: 'blue' },
  { id: 'reviewing', label: '审核中', tone: 'violet' }, { id: 'revision', label: '返工中', tone: 'amber' },
  { id: 'waiting', label: '等待额度恢复', tone: 'amber' },
  { id: 'done', label: '已完成', tone: 'green' }, { id: 'failed', label: '失败', tone: 'red' },
];
const statusLabel: Record<string, string> = Object.fromEntries(columns.map(x => [x.id, x.label]));
const nice = (value?: string) => value ? value.replaceAll('_', ' ') : '—';
const date = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未知';
const retryDate = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
const routeName = (route?: Task['route']) => [route?.harnessId, route?.modelId, route?.reasoningEffort].filter(Boolean).join(' · ') || '等待路由分配';
const taskTitle = (task: Task) => task.title || task.prompt?.split('\n')[0]?.slice(0, 72) || `任务 ${task.id.slice(0, 8)}`;

function asTasks(data: unknown): Task[] { return Array.isArray(data) ? data as Task[] : ((data as { tasks?: Task[] })?.tasks ?? []); }
function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
function Select({ value, onChange, choices, placeholder, disabled }: { value: string; onChange: (v: string) => void; choices: Choice[]; placeholder: string; disabled?: boolean }) {
  return <div className="select-wrap"><select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}><option value="">{placeholder}</option>{choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select><ChevronDown size={15} /></div>;
}
function Button({ children, onClick, variant = 'secondary', disabled, type = 'button' }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; disabled?: boolean; type?: 'button' | 'submit' }) {
  return <button className={`button ${variant}`} type={type} onClick={onClick} disabled={disabled}>{children}</button>;
}

export default function App() {
  const [page, setPage] = useState<'tasks' | 'settings'>('tasks');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capError, setCapError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tasksApiConnected, setTasksApiConnected] = useState(false);
  const [capabilitiesApiConnected, setCapabilitiesApiConnected] = useState(false);
  const serviceConnected = tasksApiConnected || capabilitiesApiConnected;
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Task | null>(null);
  const [selectedError, setSelectedError] = useState('');
  const [showSubmit, setShowSubmit] = useState(false);
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const refreshTasks = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try { setTasks(asTasks(await api.tasks())); setLoadError(''); setTasksApiConnected(true); }
    catch (e) { setLoadError(e instanceof Error ? e.message : '无法读取任务'); setTasksApiConnected(false); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  const refreshCapabilities = useCallback(async () => {
    try { setCapabilities(await api.capabilities()); setCapError(''); setCapabilitiesApiConnected(true); }
    catch (e) { setCapabilities(null); setCapError(e instanceof Error ? e.message : '无法读取 Harness 能力'); setCapabilitiesApiConnected(false); }
  }, []);

  useEffect(() => { void refreshTasks(); void refreshCapabilities(); const timer = window.setInterval(() => { void refreshTasks(true); }, 4500); return () => window.clearInterval(timer); }, [refreshTasks, refreshCapabilities]);
  useEffect(() => {
    if (!selectedId) { setSelected(null); setSelectedError(''); return; }
    let live = true;
    const update = async () => { try { const task = await api.task(selectedId); if (live) { setSelected(task); setSelectedError(''); } } catch (e) { if (live) setSelectedError(e instanceof Error ? e.message : '无法读取任务详情'); } };
    void update(); const timer = window.setInterval(() => { void update(); }, 3500);
    return () => { live = false; window.clearInterval(timer); };
  }, [selectedId]);

  const counts = useMemo(() => Object.fromEntries(columns.map(c => [c.id, tasks.filter(t => t.status === c.id).length])) as Record<Status, number>, [tasks]);
  const activeHarnesses = useMemo(() => capabilities?.harnesses ?? [], [capabilities]);
  const onCreated = (task: Task) => { setShowSubmit(false); setSelectedId(task.id); setNotice('任务已加入队列'); window.setTimeout(() => setNotice(''), 3200); void refreshTasks(true); };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Activity size={19} /></div><div><strong>Zero</strong><small>智能任务节点</small></div></div>
      <div className="sidebar-label">工作区</div>
      <button className={`nav-item ${page === 'tasks' ? 'active' : ''}`} onClick={() => setPage('tasks')}><FolderGit2 size={17} />任务看板<span className="nav-count">{tasks.length}</span></button>
      <button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><Settings2 size={17} />路由设置</button>
      <div className="sidebar-bottom"><div className="node-status"><span className={`pulse-dot ${serviceConnected ? '' : 'offline'}`} /><div><b>Zero 节点</b><small>{serviceConnected ? '本地服务已连接' : '本地服务未连接'}</small></div></div><div className="sidebar-version">v1 · 单机执行节点</div></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb">Zero <span>/</span> {page === 'tasks' ? '任务看板' : '路由设置'}</div><div className="top-actions"><button className="icon-button" title="刷新任务" onClick={() => { void refreshTasks(); void refreshCapabilities(); }}><RefreshCw size={16} className={refreshing ? 'spin' : ''} /></button><Button variant="primary" onClick={() => setShowSubmit(true)}><Plus size={16} />提交任务</Button></div></header>
      {page === 'tasks' ? <>
        <section className="page-heading"><div><div className="eyebrow">任务调度</div><h1>任务看板</h1><p>从提交到审核归档，跟踪每一步执行结果。</p></div><div className="heading-chip"><span className="pulse-dot" />自动调度已开启</div></section>
        <HarnessStrip harnesses={activeHarnesses} error={capError} />
        <section className="metrics-row">{columns.map((c) => <div className="metric" key={c.id}><span className={`metric-dot ${c.tone}`} /><span>{c.label}</span><b>{counts[c.id]}</b></div>)}</section>
        {loadError && <div className="alert error"><AlertCircle size={17} /><div><b>任务列表加载失败</b><span>{loadError}</span></div><button onClick={() => void refreshTasks()}><RefreshCw size={14} />重试</button></div>}
        {loading ? <div className="loading-state"><LoaderCircle className="spin" size={24} /><span>正在连接 Zero 服务…</span></div> : tasks.length === 0 ? <div className="empty-state"><div className="empty-icon"><TerminalSquare size={24} /></div><h2>还没有任务</h2><p>提交一个任务，Zero 会自动选择执行路线、运行检查并交由 Codex 审核。</p><Button variant="primary" onClick={() => setShowSubmit(true)}><Plus size={16} />创建第一个任务</Button></div> : <div className="board">{columns.map(col => { const items = tasks.filter(t => t.status === col.id).sort((a,b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')); return <section className="board-column" key={col.id}><div className="column-heading"><span className={`column-dot ${col.tone}`} /><b>{col.label}</b><span className="column-count">{items.length}</span></div><div className="cards">{items.map(task => <TaskCard key={task.id} task={task} onClick={() => setSelectedId(task.id)} />)}{items.length === 0 && <div className="column-empty">暂无任务</div>}</div></section>; })}</div>}
      </> : <SettingsPage capabilities={capabilities} onSaved={message => { setNotice(message); window.setTimeout(() => setNotice(''), 3200); }} onRetry={refreshCapabilities} />}
    </main>
    {selectedId && <TaskDrawer task={selected} loading={!selected && !selectedError} loadError={selectedError} onClose={() => setSelectedId(null)} onCancel={async () => { await api.cancelTask(selectedId); setNotice('已发送取消请求'); window.setTimeout(() => setNotice(''), 3200); void refreshTasks(true); }} />}
    {showSubmit && <SubmitModal capabilities={capabilities} capabilityError={capError} onClose={() => setShowSubmit(false)} onCreated={onCreated} />}
    {notice && <div className="toast"><CheckCircle2 size={16} />{notice}</div>}
  </div>;
}

function HarnessStrip({ harnesses, error }: { harnesses: HarnessHealth[]; error: string }) {
  const order = ['codex', 'dsh', 'zcode'];
  return <section className="harness-strip"><div className="strip-title"><div className="strip-icon"><Code2 size={16} /></div><div><b>Harness 能力</b><small>执行器可用性实时状态</small></div></div>
    {error ? <div className="strip-error"><AlertCircle size={15} />能力检查失败：{error}</div> : order.map(id => { const item = harnesses.find(h => h.id.toLowerCase() === id); const name = item?.name || ({ codex: 'Codex', dsh: 'DSH', zcode: 'ZCode' }[id]); return <div className="harness-health" key={id}><span className={`health-indicator ${item?.available ? 'ok' : 'off'}`} /><div><b>{name}</b><small>{item?.available ? '可用' : item?.reason || '未检测到可用配置'}</small></div>{item?.available ? <Check size={14} className="health-check" /> : <CircleHelp size={14} className="health-help" />}</div>; })}
  </section>;
}

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const doneTests = task.tests?.filter(t => t.status === 'passed' || t.status === 'success').length;
  const totalTests = task.tests?.length || 0;
  return <button className="task-card" onClick={onClick}><div className="task-card-top"><span className={`status-pill ${task.status}`}>{statusLabel[task.status] || task.status}</span><span className="task-time">{date(task.updatedAt || task.createdAt)}</span></div><h3>{taskTitle(task)}</h3><p className="task-repo"><FolderGit2 size={13} />{task.repoPath || '未指定仓库'}{task.baseRef && <span>@ {task.baseRef}</span>}</p>{task.status === 'waiting' && <p className="quota-card-note"><Clock3 size={12} />{retryDate(task.retryAt) ? `预计 ${retryDate(task.retryAt)} 自动重试` : '额度恢复后自动继续'}</p>}<div className="task-card-bottom"><span className="route-chip"><Activity size={12} />{routeName(task.route)}</span>{totalTests > 0 && <span className="test-count">{doneTests}/{totalTests} 检查</span>}</div></button>;
}

function SubmitModal({ capabilities, capabilityError, onClose, onCreated }: { capabilities: Capabilities | null; capabilityError: string; onClose: () => void; onCreated: (task: Task) => void }) {
  const [repoPath, setRepoPath] = useState(''); const [baseRef, setBaseRef] = useState('main'); const [prompt, setPrompt] = useState(''); const [criteria, setCriteria] = useState(''); const [maxRevisions, setMaxRevisions] = useState(2); const [checks, setChecks] = useState('');
  const [harnessId, setHarnessId] = useState(''); const [modelId, setModelId] = useState(''); const [effort, setEffort] = useState('');
  const [stages, setStages] = useState<Array<{ harnessId: string; modelId: string; reasoningEffort: string }>>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const bindings = useMemo(() => (capabilities?.bindings ?? []).filter(b => b.available && capabilities?.harnesses.some(h => h.id === b.harnessId && h.available)), [capabilities]);
  const filteredBindings = bindings.filter(b => !harnessId || b.harnessId === harnessId);
  const harnessChoices = [...new Map(bindings.map(b => [b.harnessId, b])).values()].map(b => ({ id: b.harnessId, label: capabilities?.harnesses.find(h => h.id === b.harnessId)?.name || b.harnessId }));
  const modelChoices = [...new Map(filteredBindings.map(b => [b.modelId, b])).values()].map(b => ({ id: b.modelId, label: b.modelName || b.modelId }));
  const selectedBinding: Binding | undefined = bindings.find(b => b.modelId === modelId && (!harnessId || b.harnessId === harnessId));
  const effortChoices = selectedBinding?.reasoningEfforts ?? (modelId ? [...new Map(bindings.filter(b => b.modelId === modelId).flatMap(b => b.reasoningEfforts ?? []).map(e => [e.id, e])).values()] : []);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); setBusy(true); try { const created = await api.createTask({ repoPath: repoPath.trim(), baseRef: baseRef.trim() || null, prompt: prompt.trim(), acceptanceCriteria: criteria.trim(), maxRevisions, checkCommands: checks.split('\n').map(s => s.trim()).filter(Boolean), execution: { harnessId: harnessId || null, modelId: modelId || null, reasoningEffort: effort || null }, ...(stages.length ? { executionStages: stages.map(stage => ({ ...(stage.harnessId ? { harnessId: stage.harnessId } : {}), ...(stage.modelId ? { modelId: stage.modelId } : {}), ...(stage.reasoningEffort ? { reasoningEffort: stage.reasoningEffort } : {}) })) } : {}) }); onCreated(created); } catch (e) { setError(e instanceof Error ? e.message : '提交失败，请稍后重试'); } finally { setBusy(false); } };
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="modal submit-modal"><div className="modal-heading"><div><div className="eyebrow">新建任务</div><h2>提交执行任务</h2><p>未指定的执行选项由 Codex 分配器根据可用能力补全。</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={submit} className="submit-form"><div className="form-grid"><Field label="仓库路径 *" hint="本机 Git 仓库的绝对路径"><input required value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder="例如 C:\\projects\\my-app" /></Field><Field label="基础分支 / Ref"><input value={baseRef} onChange={e => setBaseRef(e.target.value)} placeholder="main" /></Field></div>
      <Field label="任务描述 *"><textarea required minLength={8} rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述要实现或修复的内容、相关背景和约束…" /></Field><Field label="验收标准" hint="逐行填写，系统会交给执行器与 Reviewer"><textarea rows={3} value={criteria} onChange={e => setCriteria(e.target.value)} placeholder={'例如：\n- 登录失败时显示明确错误\n- 原有测试保持通过'} /></Field>
      <div className="section-divider"><span>执行偏好</span><span>每项可单独留空</span></div>
      <div className="form-grid three"><Field label="Harness"><Select value={harnessId} onChange={v => { setHarnessId(v); setModelId(''); setEffort(''); }} choices={harnessChoices} placeholder="Codex 自动分配" /></Field><Field label="模型"><Select value={modelId} onChange={v => { setModelId(v); setEffort(''); }} choices={modelChoices} placeholder="Codex 自动分配" disabled={!capabilities || !bindings.length} /></Field><Field label="思考强度"><Select value={effort} onChange={setEffort} choices={effortChoices} placeholder="Codex 自动分配" disabled={!modelId || effortChoices.length === 0} /></Field></div>
      <div className="stage-editor-head"><div><b>执行阶段</b><span>可选；阶段字段会覆盖上方任务默认值</span></div><Button onClick={() => setStages(current => current.length < 16 ? [...current, { harnessId: '', modelId: '', reasoningEffort: '' }] : current)} disabled={stages.length >= 16}><Plus size={14} />添加阶段</Button></div>
      {stages.map((stage, index) => {
        const effectiveHarness = stage.harnessId || harnessId;
        const effectiveModel = stage.modelId || modelId;
        const stageBindings = bindings.filter(binding => !effectiveHarness || binding.harnessId === effectiveHarness);
        const stageModels = [...new Map(stageBindings.map(binding => [binding.modelId, binding])).values()].map(binding => ({ id: binding.modelId, label: binding.modelName || binding.modelId }));
        const matchingStageBindings = bindings.filter(binding => (!effectiveHarness || binding.harnessId === effectiveHarness) && (!effectiveModel || binding.modelId === effectiveModel));
        const stageEfforts = [...new Map(matchingStageBindings.flatMap(binding => binding.reasoningEfforts ?? []).map(choice => [choice.id, choice])).values()];
        const updateStage = (key: 'harnessId' | 'modelId' | 'reasoningEffort', value: string) => setStages(current => current.map((item, i) => i === index ? { ...item, [key]: value, ...(key === 'harnessId' ? { modelId: '', reasoningEffort: '' } : key === 'modelId' ? { reasoningEffort: '' } : {}) } : item));
        return <div className="execution-stage" key={index}><div className="execution-stage-title"><b>阶段 {index + 1}</b><div className="stage-actions"><button type="button" className="link-button" aria-label={`将阶段 ${index + 1} 上移`} title="上移" disabled={index === 0} onClick={() => setStages(current => current.map((item, i) => i === index - 1 ? current[index]! : i === index ? current[index - 1]! : item))}><ArrowUp size={13} /></button><button type="button" className="link-button" aria-label={`将阶段 ${index + 1} 下移`} title="下移" disabled={index === stages.length - 1} onClick={() => setStages(current => current.map((item, i) => i === index ? current[index + 1]! : i === index + 1 ? current[index]! : item))}><ArrowDown size={13} /></button><button type="button" className="link-button" onClick={() => setStages(current => current.filter((_, i) => i !== index))}><X size={13} />移除</button></div></div><div className="form-grid three"><Field label="Harness"><Select value={stage.harnessId} onChange={v => updateStage('harnessId', v)} choices={harnessChoices} placeholder="继承任务默认值或自动分配" /></Field><Field label="模型"><Select value={stage.modelId} onChange={v => updateStage('modelId', v)} choices={stageModels} placeholder="继承任务默认值或自动分配" disabled={!capabilities || !bindings.length} /></Field><Field label="思考强度"><Select value={stage.reasoningEffort} onChange={v => updateStage('reasoningEffort', v)} choices={stageEfforts} placeholder="继承任务默认值或自动分配" disabled={stageEfforts.length === 0} /></Field></div></div>;
      })}
      {capabilityError ? <div className="inline-warning"><AlertCircle size={15} />暂时无法验证执行能力，建议刷新后再提交。提交时所有执行项将交由分配器决定。</div> : !bindings.length ? <div className="inline-warning"><AlertCircle size={15} />当前没有通过能力验证的执行组合，执行选项不可手动选择。</div> : <div className="inline-info"><ShieldCheck size={15} />仅显示已通过探测的 Harness、模型组合与思考强度。</div>}
      <div className="form-grid lower-grid"><Field label="最大返工次数"><input type="number" min="0" max="10" value={maxRevisions} onChange={e => setMaxRevisions(Number(e.target.value))} /></Field><Field label="检查命令" hint="每行一条命令，由 Zero Test Runner 执行"><textarea rows={2} value={checks} onChange={e => setChecks(e.target.value)} placeholder={'例如\nnpm test\nnpm run build'} /></Field></div>
      {error && <div className="alert error compact"><AlertCircle size={16} />{error}</div>}<div className="modal-footer"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy || !repoPath.trim() || prompt.trim().length < 8}>{busy ? <><LoaderCircle size={15} className="spin" />正在提交</> : <><Plus size={16} />加入任务队列</>}</Button></div>
    </form></section></div>;
}

function TaskDrawer({ task, loading, loadError, onClose, onCancel }: { task: Task | null; loading: boolean; loadError: string; onClose: () => void; onCancel: () => Promise<void> }) {
  const [cancelBusy, setCancelBusy] = useState(false); const [cancelError, setCancelError] = useState('');
  const cancel = async () => { setCancelBusy(true); setCancelError(''); try { await onCancel(); } catch (e) { setCancelError(e instanceof Error ? e.message : '取消请求失败'); } finally { setCancelBusy(false); } };
  const attempts = task?.attempts ?? [];
  const logs = Array.isArray(task?.logs) ? task?.logs.join('\n') : task?.logs;
  return <div className="drawer-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><aside className="task-drawer"><header className="drawer-header"><div><div className="eyebrow">任务详情</div><h2>{task ? taskTitle(task) : '正在读取任务'}</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header>
    {loading ? <div className="loading-state"><LoaderCircle className="spin" size={22} />正在读取任务详情…</div> : loadError || !task ? <div className="alert error drawer-load-error"><AlertCircle size={17} /><div><b>任务详情加载失败</b><span>{loadError}</span></div></div> : <div className="drawer-content"><div className="drawer-status-row"><span className={`status-pill ${task.status}`}>{statusLabel[task.status] || task.status}</span><span className="muted">创建于 {date(task.createdAt)}</span>{['pending', 'running', 'reviewing', 'revision', 'waiting'].includes(task.status) && <Button variant="danger" disabled={cancelBusy} onClick={() => void cancel()}>{cancelBusy ? '正在取消…' : '取消任务'}</Button>}</div>
      {task.status === 'waiting' && <section className="quota-wait-panel"><div className="quota-wait-icon"><Clock3 size={17} /></div><div><b>模型额度暂时受限</b><p>Zero 会保留当前进度，并在可重试时自动继续这个任务。</p><span>{retryDate(task.retryAt) ? `下一次自动重试：${retryDate(task.retryAt)}` : '下一次重试时间暂未确定；Zero 会在额度恢复后继续。'}</span>{task.error && <small>{task.error}</small>}</div></section>}
      {cancelError && <div className="alert error compact"><AlertCircle size={15} />{cancelError}</div>}
      <div className="detail-block"><h3><FolderGit2 size={15} />仓库与任务</h3><dl className="detail-list"><div><dt>仓库</dt><dd>{task.repoPath || '—'}</dd></div><div><dt>基础 Ref</dt><dd>{task.baseRef || '—'}</dd></div><div><dt>最大返工</dt><dd>{task.maxRevisions ?? '—'} 次</dd></div></dl><p className="pre-wrap">{task.prompt || '无任务描述'}</p>{task.acceptanceCriteria && <><div className="sub-label">验收标准</div><p className="pre-wrap">{task.acceptanceCriteria}</p></>}</div>
      <div className="detail-block"><h3><Activity size={15} />路由决策</h3><div className="route-detail"><div><span>执行路线</span><b>{routeName(task.route)}</b></div><div><span>选择来源</span><b>{nice(task.route?.selectionSource)}</b></div>{task.route?.reason && <p>{task.route.reason}</p>}</div></div>
      <div className="detail-block"><h3><ArrowDown size={15} />执行记录 <span className="count-badge">{attempts.length}</span></h3>{attempts.length ? <div className="attempt-list">{attempts.map((attempt, i) => <article className="attempt" key={attempt.number ?? i}><div className="attempt-head"><b>Attempt {attempt.number ?? i + 1}</b><span className={`tiny-status ${attempt.status || 'pending'}`}>{nice(attempt.status)}</span><span className="muted">{date(attempt.startedAt)}</span></div>{attempt.route && <div className="attempt-route">{routeName(attempt.route)}</div>}{attempt.sessionId && <div className="attempt-route">执行会话 ID：<code style={{ userSelect: 'all', overflowWrap: 'anywhere' }}>{attempt.sessionId}</code></div>}{attempt.summary && <p>{attempt.summary}</p>}{attempt.tests && <TestList tests={attempt.tests} />}{attempt.review && <Review review={attempt.review} />}{attempt.logs && <pre className="log-box">{Array.isArray(attempt.logs) ? attempt.logs.join('\n') : attempt.logs}</pre>}</article>)}</div> : <div className="soft-empty">任务开始后，执行尝试和测试结果会显示在这里。</div>}</div>
      {!attempts.length && task.tests && task.tests.length > 0 && <div className="detail-block"><h3><CheckCircle2 size={15} />测试结果</h3><TestList tests={task.tests} /></div>}
      {task.review && <div className="detail-block"><h3><ShieldCheck size={15} />Codex 审核</h3><Review review={task.review} /></div>}
      {task.error && <div className="detail-block"><h3><AlertCircle size={15} />错误信息</h3><pre className="error-box">{task.error}</pre></div>}
      {logs && <div className="detail-block"><h3><TerminalSquare size={15} />任务日志</h3><pre className="log-box large">{logs}</pre></div>}
      {task.report && <div className="detail-block"><h3><FileText size={15} />执行报告</h3><a className="report-link" href={task.report} target="_blank" rel="noreferrer"><FileText size={15} />打开归档报告<ArrowRight size={14} /></a></div>}
    </div>}</aside></div>;
}

function TestList({ tests }: { tests: TestResult[] }) {
  return <div className="test-list">{tests.map((t, i) => { const good = t.status === 'passed' || t.status === 'success'; return <div className="test-row" key={i}><span className={`test-icon ${good ? 'good' : t.status === 'failed' ? 'bad' : ''}`}>{good ? <CheckCircle2 size={15} /> : t.status === 'failed' ? <XCircle size={15} /> : <Clock3 size={15} />}</span><div><b>{t.name || t.command || `检查 ${i + 1}`}</b>{t.command && t.name && <code>{t.command}</code>}</div><span className={`test-status ${good ? 'good' : t.status === 'failed' ? 'bad' : ''}`}>{nice(t.status)}{t.exitCode != null ? ` · ${t.exitCode}` : ''}</span></div>; })}</div>;
}
function Review({ review }: { review: NonNullable<Task['review']> }) {
  const pass = review.verdict === 'pass' || review.verdict === 'approved';
  return <div className="review-card"><div className="review-head"><span className={`review-verdict ${pass ? 'pass' : 'needs'}`}>{pass ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}{nice(review.verdict)}</span>{review.modelId && <span className="muted">{review.modelId}</span>}</div>{review.summary && <p>{review.summary}</p>}{review.findings?.map((f, i) => <div className="finding" key={i}><b>{f.severity || '意见'}</b>{f.file && <code>{f.file}{f.line ? `:${f.line}` : ''}</code>}<span>{f.message}</span></div>)}</div>;
}

function SettingsPage({ capabilities, onSaved, onRetry }: { capabilities: Capabilities | null; onSaved: (message: string) => void; onRetry: () => Promise<void> }) {
  const [config, setConfig] = useState<Config | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false);
  useEffect(() => { let live = true; api.config().then(c => { if (live) { setConfig(c); setError(''); } }).catch(e => { if (live) setError(e instanceof Error ? e.message : '配置读取失败'); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, []);
  const save = async () => { if (!config) return; setBusy(true); setError(''); try { const updated = await api.saveConfig(config); setConfig(updated); setSaved(true); onSaved('路由设置已保存'); window.setTimeout(() => setSaved(false), 2200); } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); } };
  const update = (role: 'allocator' | 'reviewer', key: 'modelId' | 'reasoningEffort', value: string) => setConfig(prev => prev ? { ...prev, [role]: { ...prev[role], [key]: value || null, ...(key === 'modelId' ? { reasoningEffort: null } : {}) } } : prev);
  const options = (role: 'allocator' | 'reviewer', key: 'models' | 'reasoningEfforts') => capabilities?.[role]?.[key] ?? [];
  const effortOptions = (role: 'allocator' | 'reviewer') => {
    const modelId = config?.[role].modelId;
    if (!modelId) return options(role, 'reasoningEfforts');
    return [...new Map((capabilities?.bindings ?? []).filter(binding => binding.harnessId === 'codex' && binding.modelId === modelId && binding.available)
      .flatMap(binding => binding.reasoningEfforts ?? []).map(choice => [choice.id, choice])).values()];
  };
  return <><section className="page-heading"><div><div className="eyebrow">执行策略</div><h1>路由设置</h1><p>Codex 固定担任分配器与 Reviewer，可在这里设置默认模型和思考强度。</p></div></section>
    <div className="settings-layout"><div className="settings-main">
      {loading ? <div className="settings-card loading-state"><LoaderCircle className="spin" size={21} />正在读取设置…</div> : error && !config ? <div className="alert error"><AlertCircle size={17} /><div><b>设置暂不可用</b><span>{error}</span></div><Button onClick={() => { setLoading(true); api.config().then(setConfig).catch(e => setError(String(e))).finally(() => setLoading(false)); }}>重试</Button></div> : config && <>
        <section className="settings-card"><div className="settings-card-head"><div className="role-icon codex"><Activity size={18} /></div><div><h2>Codex 分配器</h2><p>未设置时使用已验证的 Codex CLI 默认模型或全局启动配置。</p></div><span className="fixed-badge">固定 Codex</span></div><div className="form-grid"><Field label="默认模型"><Select value={config.allocator.modelId || ''} onChange={v => update('allocator', 'modelId', v)} choices={options('allocator', 'models')} placeholder="使用 Codex CLI 默认模型" /></Field><Field label="默认思考强度"><Select value={config.allocator.reasoningEffort || ''} onChange={v => update('allocator', 'reasoningEffort', v)} choices={effortOptions('allocator')} placeholder="使用 Codex CLI 默认值" /></Field></div></section>
        <section className="settings-card"><div className="settings-card-head"><div className="role-icon reviewer"><ShieldCheck size={18} /></div><div><h2>Codex Reviewer</h2><p>独立只读会话审核改动、测试证据和验收标准。</p></div><span className="fixed-badge">固定 Codex</span></div><div className="form-grid"><Field label="审核模型"><Select value={config.reviewer.modelId || ''} onChange={v => update('reviewer', 'modelId', v)} choices={options('reviewer', 'models')} placeholder="Codex 自动选择" /></Field><Field label="审核思考强度"><Select value={config.reviewer.reasoningEffort || ''} onChange={v => update('reviewer', 'reasoningEffort', v)} choices={effortOptions('reviewer')} placeholder="Codex 自动选择" /></Field></div></section>
        <div className="settings-save-row"><span><ShieldCheck size={14} />密钥由服务端管理，界面不会读取或保存密钥原文。</span><Button variant="primary" disabled={busy || saved} onClick={() => void save()}>{busy ? <><LoaderCircle size={15} className="spin" />保存中</> : saved ? <><Check size={15} />已保存</> : '保存设置'}</Button></div>{error && <div className="alert error compact"><AlertCircle size={16} />{error}</div>}
      </>}
    </div><aside className="settings-aside"><div className="aside-icon"><ShieldCheck size={19} /></div><h3>选择优先级</h3><p>每个任务的手动指定优先于项目预设与全局预设；未指定字段由 Codex 补全。</p><div className="priority-stack"><div><span>1</span><b>任务指定</b></div><ArrowDown size={14} /><div><span>2</span><b>项目预设</b></div><ArrowDown size={14} /><div><span>3</span><b>全局预设</b></div><ArrowDown size={14} /><div><span>4</span><b>Codex 分配</b></div></div><button className="link-button" onClick={() => void onRetry()}><RefreshCw size={13} />刷新能力状态</button></aside></div>
  </>;
}
