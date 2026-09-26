import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, AlertCircle, ArrowDown, ArrowRight, ArrowUp, Check, CheckCircle2, ChevronDown, CircleHelp, Clock3, Code2, FileText, FolderGit2, ListOrdered, LoaderCircle, Plus, RefreshCw, Settings2, ShieldCheck, Target, TerminalSquare, X, XCircle } from 'lucide-react';
import { api } from './api';
import type { Binding, Capabilities, Choice, Config, HarnessHealth, Status, Task, TaskSequence, TestResult } from './types';

const columns: { id: Status; label: string; tone: string }[] = [
  { id: 'pending', label: '待处理', tone: 'slate' }, { id: 'running', label: '执行中', tone: 'blue' },
  { id: 'reviewing', label: '审核中', tone: 'violet' }, { id: 'revision', label: '返工中', tone: 'amber' },
  { id: 'waiting', label: '等待额度恢复', tone: 'amber' },
  { id: 'recovery_required', label: '需要检查恢复', tone: 'red' },
  { id: 'done', label: '已完成', tone: 'green' }, { id: 'failed', label: '失败', tone: 'red' },
];
const statusLabel: Record<string, string> = Object.fromEntries(columns.map(x => [x.id, x.label]));
const sequenceStatusLabel: Record<TaskSequence['status'], string> = { queued: '排队中', running: '执行中', waiting: '等待额度恢复', blocked: '被阻塞', steps_completed: '步骤已完成，待目标验收', completed: '已完成' };
const nice = (value?: string) => value ? value.replaceAll('_', ' ') : '—';
const date = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未知';
const retryDate = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
const routeName = (route?: Task['route']) => [route?.harnessId, route?.modelId, route?.reasoningEffort].filter(Boolean).join(' · ') || '等待路由分配';
const taskTitle = (task: Task) => task.title || task.prompt?.split('\n')[0]?.slice(0, 72) || `任务 ${task.id.slice(0, 8)}`;
type ApiAllocatorConfig = NonNullable<Config['allocator']['api']>;
const emptyApiAllocatorConfig: ApiAllocatorConfig = { baseUrl: null, model: null, keyEnv: null };
const normalizeConfig = (config: Config): Config => ({ ...config, allocator: { ...config.allocator, api: config.allocator.api ?? { ...emptyApiAllocatorConfig } } });

function asTasks(data: unknown): Task[] { return Array.isArray(data) ? data as Task[] : ((data as { tasks?: Task[] })?.tasks ?? []); }
function asSequences(data: TaskSequence[] | { sequences: TaskSequence[] }): TaskSequence[] { return Array.isArray(data) ? data : data.sequences ?? []; }
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
  const [sequences, setSequences] = useState<TaskSequence[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [allocatorKind, setAllocatorKind] = useState<Config['allocator']['kind']>('codex');
  const [capError, setCapError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tasksApiConnected, setTasksApiConnected] = useState(false);
  const [capabilitiesApiConnected, setCapabilitiesApiConnected] = useState(false);
  const serviceConnected = tasksApiConnected || capabilitiesApiConnected;
  const [loadError, setLoadError] = useState('');
  const [sequenceError, setSequenceError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Task | null>(null);
  const [selectedError, setSelectedError] = useState('');
  const [showSubmit, setShowSubmit] = useState(false);
  const [showSequenceSubmit, setShowSequenceSubmit] = useState(false);
  const [selectedSequenceId, setSelectedSequenceId] = useState<string | null>(null);
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

  const refreshSequences = useCallback(async () => {
    try { setSequences(asSequences(await api.sequences())); setSequenceError(''); }
    catch (e) { setSequenceError(e instanceof Error ? e.message : '无法读取目标序列'); }
  }, []);

  useEffect(() => { void refreshTasks(); void refreshCapabilities(); void refreshSequences(); void api.config().then(config => setAllocatorKind(config.allocator.kind)).catch(() => {}); const timer = window.setInterval(() => { void refreshTasks(true); void refreshSequences(); }, 4500); return () => window.clearInterval(timer); }, [refreshTasks, refreshCapabilities, refreshSequences]);
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
      <header className="topbar"><div className="breadcrumb">Zero <span>/</span> {page === 'tasks' ? '任务看板' : '路由设置'}</div><div className="top-actions"><button className="icon-button" title="刷新任务" onClick={() => { void refreshTasks(); void refreshCapabilities(); void refreshSequences(); }}><RefreshCw size={16} className={refreshing ? 'spin' : ''} /></button>{page === 'tasks' && <Button onClick={() => setShowSequenceSubmit(true)}><ListOrdered size={15} />提交目标</Button>}<Button variant="primary" onClick={() => setShowSubmit(true)}><Plus size={16} />提交任务</Button></div></header>
      {page === 'tasks' ? <>
        <section className="page-heading"><div><div className="eyebrow">任务调度</div><h1>任务看板</h1><p>从提交到审核归档，跟踪每一步执行结果。</p></div><div className="heading-chip"><span className="pulse-dot" />自动调度已开启</div></section>
        <HarnessStrip harnesses={activeHarnesses} error={capError} />
        <section className="metrics-row">{columns.map((c) => <div className="metric" key={c.id}><span className={`metric-dot ${c.tone}`} /><span>{c.label}</span><b>{counts[c.id]}</b></div>)}</section>
        <SequenceProgressSection sequences={sequences} error={sequenceError} onOpen={id => setSelectedSequenceId(id)} onCreate={() => setShowSequenceSubmit(true)} />
        {loadError && <div className="alert error"><AlertCircle size={17} /><div><b>任务列表加载失败</b><span>{loadError}</span></div><button onClick={() => void refreshTasks()}><RefreshCw size={14} />重试</button></div>}
        {loading ? <div className="loading-state"><LoaderCircle className="spin" size={24} /><span>正在连接 Zero 服务…</span></div> : tasks.length === 0 ? <div className="empty-state"><div className="empty-icon"><TerminalSquare size={24} /></div><h2>还没有任务</h2><p>提交一个任务，Zero 会自动选择执行路线、运行检查并交由 Codex 审核。</p><Button variant="primary" onClick={() => setShowSubmit(true)}><Plus size={16} />创建第一个任务</Button></div> : <div className="board">{columns.map(col => { const items = tasks.filter(t => t.status === col.id).sort((a,b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')); return <section className="board-column" key={col.id}><div className="column-heading"><span className={`column-dot ${col.tone}`} /><b>{col.label}</b><span className="column-count">{items.length}</span></div><div className="cards">{items.map(task => <TaskCard key={task.id} task={task} onClick={() => setSelectedId(task.id)} />)}{items.length === 0 && <div className="column-empty">暂无任务</div>}</div></section>; })}</div>}
      </> : <SettingsPage capabilities={capabilities} onSaved={(message, kind) => { setAllocatorKind(kind); setNotice(message); window.setTimeout(() => setNotice(''), 3200); }} onRetry={refreshCapabilities} />}
    </main>
    {selectedId && <TaskDrawer task={selected} loading={!selected && !selectedError} loadError={selectedError} onClose={() => setSelectedId(null)} onCancel={async () => { await api.cancelTask(selectedId); setNotice('已发送取消请求'); window.setTimeout(() => setNotice(''), 3200); void refreshTasks(true); }} />}
    {showSubmit && <SubmitModal capabilities={capabilities} capabilityError={capError} allocatorKind={allocatorKind} onClose={() => setShowSubmit(false)} onCreated={task => { onCreated(task); void refreshSequences(); }} />}
    {showSequenceSubmit && <SequenceSubmitModal capabilities={capabilities} onClose={() => setShowSequenceSubmit(false)} onCreated={sequence => { setShowSequenceSubmit(false); setSelectedSequenceId(sequence.id); void refreshSequences(); void refreshTasks(true); }} />}
    {selectedSequenceId && <SequenceDrawer id={selectedSequenceId} onClose={() => setSelectedSequenceId(null)} onOpenTask={id => { setSelectedSequenceId(null); setSelectedId(id); }} />}
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

function SequenceProgressSection({ sequences, error, onOpen, onCreate }: { sequences: TaskSequence[]; error: string; onOpen: (id: string) => void; onCreate: () => void }) {
  if (!sequences.length && !error) return <section className="sequence-section"><div className="sequence-section-heading"><div><h2><Target size={16} />目标序列</h2><p>把一个目标拆成至少两个按顺序执行的任务。</p></div><Button onClick={onCreate}><ListOrdered size={14} />提交目标</Button></div></section>;
  return <section className="sequence-section"><div className="sequence-section-heading"><div><h2><Target size={16} />目标序列</h2><p>按顺序查看目标拆解任务的进度。</p></div><Button onClick={onCreate}><ListOrdered size={14} />提交目标</Button></div>
    {error ? <div className="alert error compact"><AlertCircle size={15} />{error}</div> : <div className="sequence-list">{sequences.map(sequence => {
      const completed = sequence.steps.filter(step => step.task.status === 'done').length;
      return <button className="sequence-card" key={sequence.id} onClick={() => onOpen(sequence.id)}><div className="sequence-card-head"><b>{sequence.objective || taskTitle(sequence.steps[0]?.task ?? { id: sequence.id, status: 'pending' })}</b><span className={`sequence-state ${sequence.status}`}>{sequenceStatusLabel[sequence.status]}</span></div><div className="sequence-card-meta">{completed}/{sequence.steps.length} 步骤已完成 · 更新于 {date(sequence.updatedAt)}</div><div className="sequence-mini-steps">{sequence.steps.map(step => <span key={step.task.id} className={step.task.status === 'done' ? 'done' : step.task.status === 'failed' || step.task.status === 'recovery_required' ? 'blocked' : ''}>{step.position + 1}. {taskTitle(step.task)}</span>)}</div>
        {sequence.status === 'steps_completed' && <div className="sequence-goal-note"><AlertCircle size={14} />所有步骤已完成；目标级 Codex 验收尚未完成。</div>}
        {sequence.goalReview?.state === 'verdict' && <div className="sequence-goal-note">{sequence.goalReview.result?.verdict === 'pass' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}目标验收 {sequence.goalReview.result?.verdict?.toUpperCase() || '已完成'}：{sequence.goalReview.result?.summary}</div>}
        {sequence.goalReview?.state === 'quota' && <div className="sequence-goal-note"><Clock3 size={14} />目标验收等待额度恢复{sequence.goalReview.retryAt ? `，计划重试时间：${date(sequence.goalReview.retryAt)}` : ''}</div>}
        {sequence.goalReview?.state === 'running' && <div className="sequence-goal-note"><Activity size={14} />正在进行目标级 Codex 验收。</div>}
        {sequence.status === 'completed' && !sequence.goalReview && <div className="sequence-goal-note"><CheckCircle2 size={14} />所有步骤已完成；未配置额外的目标级验收条件。</div>}
      </button>;
    })}</div>}
  </section>;
}

type SequenceStepDraft = { prompt: string; criteria: string; checks: string; harnessId: string; modelId: string; reasoningEffort: string };
function SequenceSubmitModal({ capabilities, onClose, onCreated }: { capabilities: Capabilities | null; onClose: () => void; onCreated: (sequence: TaskSequence) => void }) {
  const [repoPath, setRepoPath] = useState(''); const [baseRef, setBaseRef] = useState('main'); const [objective, setObjective] = useState(''); const [goalCriteria, setGoalCriteria] = useState('');
  const [maxRevisions, setMaxRevisions] = useState(2);
  const blankStep = (): SequenceStepDraft => ({ prompt: '', criteria: '', checks: '', harnessId: '', modelId: '', reasoningEffort: '' });
  const [steps, setSteps] = useState<SequenceStepDraft[]>([blankStep(), blankStep()]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const bindings = useMemo(() => (capabilities?.bindings ?? []).filter(binding => binding.available && capabilities?.harnesses.some(harness => harness.id === binding.harnessId && harness.available)), [capabilities]);
  const harnessChoices = [...new Map(bindings.map(binding => [binding.harnessId, binding])).values()].map(binding => ({ id: binding.harnessId, label: capabilities?.harnesses.find(harness => harness.id === binding.harnessId)?.name || binding.harnessId }));
  const updateStep = (index: number, key: keyof SequenceStepDraft, value: string) => setSteps(current => current.map((step, i) => i === index ? { ...step, [key]: value, ...(key === 'harnessId' ? { modelId: '', reasoningEffort: '' } : key === 'modelId' ? { reasoningEffort: '' } : {}) } : step));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (steps.length < 2 || steps.some(step => step.prompt.trim().length < 8)) { setError('至少需要两个步骤，每个步骤的描述至少填写 8 个字符。'); return; }
    for (const [index, step] of steps.entries()) {
      const candidates = bindings.filter(binding => (!step.harnessId || binding.harnessId === step.harnessId) && (!step.modelId || binding.modelId === step.modelId));
      if ((step.harnessId || step.modelId || step.reasoningEffort) && !candidates.length) { setError(`步骤 ${index + 1} 的 Harness 与模型没有通过验证的可用组合。`); return; }
      if (step.reasoningEffort && !candidates.some(binding => binding.reasoningEfforts?.some(choice => choice.id === step.reasoningEffort))) { setError(`步骤 ${index + 1} 的思考强度与 Harness、模型组合不匹配。`); return; }
    }
    setBusy(true);
    try {
      const created = await api.createSequence({ ...(objective.trim() ? { objective: objective.trim() } : {}), ...(goalCriteria.trim() ? { acceptanceCriteria: goalCriteria.split('\n').map(line => line.trim()).filter(Boolean) } : {}), tasks: steps.map(step => ({ repoPath: repoPath.trim(), baseRef: baseRef.trim() || null, prompt: step.prompt.trim(), acceptanceCriteria: step.criteria.trim(), checkCommands: step.checks.split('\n').map(line => line.trim()).filter(Boolean), maxRevisions, execution: { harnessId: step.harnessId || null, modelId: step.modelId || null, reasoningEffort: step.reasoningEffort || null } })) });
      onCreated(created);
    } catch (e) { setError(e instanceof Error ? e.message : '目标提交失败，请稍后重试'); }
    finally { setBusy(false); }
  };
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="modal submit-modal sequence-submit-modal"><div className="modal-heading"><div><div className="eyebrow">目标执行</div><h2>提交有序任务序列</h2><p>Zero 会按顺序执行这些步骤，后续步骤接续前一步的结果。</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={submit} className="submit-form"><div className="form-grid"><Field label="仓库路径 *" hint="所有步骤使用此仓库"><input required value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder="例如 C:\\projects\\my-app" /></Field><Field label="基础分支 / Ref" hint="所有步骤使用此 Ref"><input value={baseRef} onChange={e => setBaseRef(e.target.value)} placeholder="main" /></Field></div>
      <Field label="整体目标" hint="可选；留空时按步骤完成情况结束序列。"><input value={objective} onChange={e => setObjective(e.target.value)} placeholder="例如：为服务添加可靠的登录与账户管理" /></Field>
      <Field label="目标级验收标准" hint="可选，逐行填写。这些标准不会由单个步骤的完成状态自动判定。"><textarea rows={2} value={goalCriteria} onChange={e => setGoalCriteria(e.target.value)} placeholder="列出需要整体评估的目标条件" /></Field>
      <div className="form-grid"><Field label="每个步骤的最大返工次数"><input type="number" min="0" max="10" value={maxRevisions} onChange={e => setMaxRevisions(Number(e.target.value))} /></Field></div>
      <div className="section-divider"><span>按顺序执行的步骤</span><span>至少 2 步，共用仓库与基础 Ref</span></div>
      {steps.map((step, index) => {
        const stepBindings = bindings.filter(binding => !step.harnessId || binding.harnessId === step.harnessId);
        const modelChoices = [...new Map(stepBindings.map(binding => [binding.modelId, binding])).values()].map(binding => ({ id: binding.modelId, label: binding.modelName || binding.modelId }));
        const matchingBindings = stepBindings.filter(binding => !step.modelId || binding.modelId === step.modelId);
        const effortChoices = step.modelId ? [...new Map(matchingBindings.flatMap(binding => binding.reasoningEfforts ?? []).map(choice => [choice.id, choice])).values()] : [];
        return <section className="sequence-step-editor" key={index}><div className="execution-stage-title"><b>步骤 {index + 1}</b><div className="stage-actions"><button type="button" className="link-button" aria-label={`将步骤 ${index + 1} 上移`} title="上移" disabled={index === 0} onClick={() => setSteps(current => current.map((item, i) => i === index - 1 ? current[index]! : i === index ? current[index - 1]! : item))}><ArrowUp size={13} /></button><button type="button" className="link-button" aria-label={`将步骤 ${index + 1} 下移`} title="下移" disabled={index === steps.length - 1} onClick={() => setSteps(current => current.map((item, i) => i === index ? current[index + 1]! : i === index + 1 ? current[index]! : item))}><ArrowDown size={13} /></button><button type="button" className="link-button" disabled={steps.length <= 2} onClick={() => setSteps(current => current.filter((_, i) => i !== index))}><X size={13} />移除</button></div></div>
        <Field label={`步骤 ${index + 1} 描述 *`}><textarea required minLength={8} rows={3} value={step.prompt} onChange={e => updateStep(index, 'prompt', e.target.value)} placeholder="描述这一阶段要实现或验证的内容" /></Field>
        <div className="form-grid"><Field label="步骤验收标准" hint="可选，逐行填写"><textarea rows={2} value={step.criteria} onChange={e => updateStep(index, 'criteria', e.target.value)} placeholder="此步骤需要满足的条件" /></Field><Field label="检查命令" hint="可选，每行一条命令"><textarea rows={2} value={step.checks} onChange={e => updateStep(index, 'checks', e.target.value)} placeholder={'例如\nnpm test'} /></Field></div>
        <div className="form-grid three"><Field label="Harness"><Select value={step.harnessId} onChange={value => updateStep(index, 'harnessId', value)} choices={harnessChoices} placeholder="分配器自动选择" /></Field><Field label="模型"><Select value={step.modelId} onChange={value => updateStep(index, 'modelId', value)} choices={modelChoices} placeholder="分配器自动选择" disabled={!capabilities || !stepBindings.length} /></Field><Field label="思考强度"><Select value={step.reasoningEffort} onChange={value => updateStep(index, 'reasoningEffort', value)} choices={effortChoices} placeholder="分配器自动选择" disabled={!step.modelId || effortChoices.length === 0} /></Field></div>
      </section>;
      })}
      <Button onClick={() => setSteps(current => current.length < 16 ? [...current, blankStep()] : current)} disabled={steps.length >= 16}><Plus size={14} />添加步骤</Button>
      {capabilities && bindings.length > 0 ? <div className="inline-info sequence-allocator-note"><Activity size={14} />每个步骤可单独指定 Harness、模型和思考强度；留空字段由当前分配器自动选择。</div> : <div className="inline-warning sequence-allocator-note"><AlertCircle size={14} />当前没有可用的已验证执行组合；所有留空选项将由分配器决定。</div>}
      {error && <div className="alert error compact"><AlertCircle size={16} />{error}</div>}<div className="modal-footer"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy || !repoPath.trim() || steps.some(step => step.prompt.trim().length < 8)}>{busy ? <><LoaderCircle size={15} className="spin" />正在提交</> : <><ListOrdered size={16} />提交目标序列</>}</Button></div>
    </form></section></div>;
}

function SequenceDrawer({ id, onClose, onOpenTask }: { id: string; onClose: () => void; onOpenTask: (taskId: string) => void }) {
  const [sequence, setSequence] = useState<TaskSequence | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const update = async () => { try { const result = await api.sequence(id); if (live) { setSequence(result); setError(''); } } catch (e) { if (live) setError(e instanceof Error ? e.message : '无法读取目标详情'); } };
    void update(); const timer = window.setInterval(() => { void update(); }, 4500);
    return () => { live = false; window.clearInterval(timer); };
  }, [id]);
  const status = sequence?.status;
  const allStepsDone = Boolean(sequence && sequence.steps.length > 0 && sequence.steps.every(step => step.task.status === 'done'));
  return <div className="drawer-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><aside className="task-drawer sequence-drawer"><header className="drawer-header"><div><div className="eyebrow">目标进度</div><h2>{sequence?.objective || (sequence ? taskTitle(sequence.steps[0]?.task ?? { id: sequence.id, status: 'pending' }) : '正在读取目标')}</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header>
    {error && !sequence ? <div className="alert error"><AlertCircle size={17} /><div><b>目标读取失败</b><span>{error}</span></div></div> : !sequence ? <div className="loading-state"><LoaderCircle className="spin" size={22} />正在读取目标进度…</div> : <div className="drawer-content">
      <div className="drawer-status-row"><span className={`sequence-state ${status}`}>{sequenceStatusLabel[sequence.status]}</span><span className="muted">{sequence.steps.filter(step => step.task.status === 'done').length}/{sequence.steps.length} 步骤已完成</span></div>
      {sequence.status === 'steps_completed' && <section className="sequence-goal-callout pending"><Target size={17} /><div><b>步骤已完成，等待目标级 Codex 验收</b><p>步骤完成本身不代表整体目标已通过。自动目标级返工尚未实现；如验收未通过，请按下方发现处理。</p></div></section>}
      {sequence.goalReview?.state === 'running' && <section className="sequence-goal-callout pending"><Activity size={17} /><div><b>正在进行目标级 Codex 验收</b><p>验收根据完整序列结果和目标条件进行。</p></div></section>}
      {sequence.goalReview?.state === 'quota' && <section className="sequence-goal-callout pending"><Clock3 size={17} /><div><b>目标级验收等待额度恢复</b><p>{sequence.goalReview.retryAt ? `计划重试时间：${date(sequence.goalReview.retryAt)}` : '额度恢复后将重试。'}</p></div></section>}
      {sequence.goalReview?.state === 'verdict' && <section className={`sequence-goal-callout ${sequence.goalReview.result?.verdict === 'pass' ? 'done' : 'pending'}`}><Target size={17} /><div><b>目标验收：{sequence.goalReview.result?.verdict?.toUpperCase() || '未知'}</b><p>{sequence.goalReview.result?.summary}</p>{sequence.goalReview.result?.verdict !== 'pass' && <p>自动目标级返工尚未实现；请依据以下发现处理。</p>}{sequence.goalReview.result?.findings?.length ? <ul className="sequence-criteria">{sequence.goalReview.result.findings.map((finding, index) => <li key={index}><b>{finding.severity || 'finding'}</b>{finding.file ? ` · ${finding.file}${finding.line ? `:${finding.line}` : ''}` : ''} — {finding.message}</li>)}</ul> : null}</div></section>}
      {sequence.status === 'completed' && !sequence.goalReview && <section className="sequence-goal-callout done"><CheckCircle2 size={17} /><div><b>序列已完成</b><p>所有任务步骤已完成；此序列未配置额外的目标级验收条件。</p></div></section>}
      {sequence.blockedReason && <div className="alert error compact"><AlertCircle size={15} /><span>{allStepsDone && sequence.goalReview?.state === 'verdict' && sequence.goalReview.result?.verdict !== 'pass' ? '目标验收受阻' : '步骤受阻'}：{sequence.blockedReason.reason || statusLabel[sequence.blockedReason.status] || sequence.blockedReason.status}</span></div>}
      {sequence.acceptanceCriteria?.length ? <div className="detail-block"><h3><Target size={15} />目标级验收标准</h3><ul className="sequence-criteria">{sequence.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></div> : sequence.objective && <div className="detail-block"><h3><Target size={15} />整体目标</h3><p className="pre-wrap">{sequence.objective}</p></div>}
      <div className="detail-block"><h3><ListOrdered size={15} />有序步骤 <span className="count-badge">{sequence.steps.length}</span></h3><div className="sequence-detail-steps">{sequence.steps.map(step => <article className="sequence-detail-step" key={step.task.id}><div className="sequence-detail-step-head"><span className={`sequence-step-number ${step.task.status}`}>{step.position + 1}</span><b>{taskTitle(step.task)}</b><span className={`status-pill ${step.task.status}`}>{statusLabel[step.task.status] || step.task.status}</span></div>{step.task.error && <p>{step.task.error}</p>}<Button onClick={() => onOpenTask(step.task.id)}><ArrowRight size={13} />查看步骤任务</Button></article>)}</div></div>
    </div>}</aside></div>;
}

function SubmitModal({ capabilities, capabilityError, allocatorKind, onClose, onCreated }: { capabilities: Capabilities | null; capabilityError: string; allocatorKind: Config['allocator']['kind']; onClose: () => void; onCreated: (task: Task) => void }) {
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
  const allocatorName = allocatorKind === 'api' ? 'API 模型' : 'Codex';
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="modal submit-modal"><div className="modal-heading"><div><div className="eyebrow">新建任务</div><h2>提交执行任务</h2><p>未指定的执行选项由 {allocatorName} 分配器根据可用能力补全。</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={submit} className="submit-form"><div className="form-grid"><Field label="仓库路径 *" hint="本机 Git 仓库的绝对路径"><input required value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder="例如 C:\\projects\\my-app" /></Field><Field label="基础分支 / Ref"><input value={baseRef} onChange={e => setBaseRef(e.target.value)} placeholder="main" /></Field></div>
      <Field label="任务描述 *"><textarea required minLength={8} rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述要实现或修复的内容、相关背景和约束…" /></Field><Field label="验收标准" hint="逐行填写，系统会交给执行器与 Reviewer"><textarea rows={3} value={criteria} onChange={e => setCriteria(e.target.value)} placeholder={'例如：\n- 登录失败时显示明确错误\n- 原有测试保持通过'} /></Field>
      <div className="section-divider"><span>执行偏好</span><span>每项可单独留空</span></div>
      <div className="form-grid three"><Field label="Harness"><Select value={harnessId} onChange={v => { setHarnessId(v); setModelId(''); setEffort(''); }} choices={harnessChoices} placeholder={`${allocatorName} 自动分配`} /></Field><Field label="模型"><Select value={modelId} onChange={v => { setModelId(v); setEffort(''); }} choices={modelChoices} placeholder={`${allocatorName} 自动分配`} disabled={!capabilities || !bindings.length} /></Field><Field label="思考强度"><Select value={effort} onChange={setEffort} choices={effortChoices} placeholder={`${allocatorName} 自动分配`} disabled={!modelId || effortChoices.length === 0} /></Field></div>
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
      {task.status === 'recovery_required' && <section className="quota-wait-panel recovery-required-panel"><div className="quota-wait-icon"><AlertCircle size={17} /></div><div><b>任务需要人工检查</b><p>{task.recoveryReason || '执行租约已过期。租约过期不能证明原进程已停止，因此 Zero 未自动重试。'}</p><span>请检查旧 worker 进程和任务 worktree，再决定如何继续。</span>{task.recoveryEvidence && <small>恢复证据：{JSON.stringify(task.recoveryEvidence)}</small>}</div></section>}
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

function SettingsPage({ capabilities, onSaved, onRetry }: { capabilities: Capabilities | null; onSaved: (message: string, kind: Config['allocator']['kind']) => void; onRetry: () => Promise<void> }) {
  const [config, setConfig] = useState<Config | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false);
  useEffect(() => { let live = true; api.config().then(c => { if (live) { setConfig(normalizeConfig(c)); setError(''); } }).catch(e => { if (live) setError(e instanceof Error ? e.message : '配置读取失败'); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, []);
  const save = async () => {
    if (!config) return;
    if (config.allocator.kind === 'api') {
      let secureEndpoint = false;
      const apiConfig = config.allocator.api ?? emptyApiAllocatorConfig;
      try { secureEndpoint = new URL(apiConfig.baseUrl ?? '').protocol === 'https:'; } catch { /* Invalid or missing URL. */ }
      if (!secureEndpoint || !apiConfig.model?.trim() || !apiConfig.keyEnv?.trim()) {
        setError('请填写有效的 HTTPS 地址、API 模型和密钥环境变量名。');
        return;
      }
    }
    setBusy(true); setError(''); try { const updated = normalizeConfig(await api.saveConfig(normalizeConfig(config))); setConfig(updated); setSaved(true); onSaved('路由设置已保存', updated.allocator.kind); window.setTimeout(() => setSaved(false), 2200); } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  };
  const update = (role: 'allocator' | 'reviewer', key: 'modelId' | 'reasoningEffort', value: string) => setConfig(prev => prev ? { ...normalizeConfig(prev), [role]: { ...prev[role], [key]: value || null, ...(key === 'modelId' ? { reasoningEffort: null } : {}) } } : prev);
  const updateApi = (key: keyof ApiAllocatorConfig, value: string) => setConfig(prev => prev ? { ...normalizeConfig(prev), allocator: { ...prev.allocator, api: { ...(prev.allocator.api ?? emptyApiAllocatorConfig), [key]: value || null } } } : prev);
  const options = (role: 'allocator' | 'reviewer', key: 'models' | 'reasoningEfforts') => capabilities?.[role]?.[key] ?? [];
  const effortOptions = (role: 'allocator' | 'reviewer') => {
    const modelId = config?.[role].modelId;
    if (!modelId) return options(role, 'reasoningEfforts');
    return [...new Map((capabilities?.bindings ?? []).filter(binding => binding.harnessId === 'codex' && binding.modelId === modelId && binding.available)
      .flatMap(binding => binding.reasoningEfforts ?? []).map(choice => [choice.id, choice])).values()];
  };
  const allocatorName = config?.allocator.kind === 'api' ? 'API 模型' : 'Codex';
  const apiAllocatorConfig = config?.allocator.api ?? emptyApiAllocatorConfig;
  return <><section className="page-heading"><div><div className="eyebrow">执行策略</div><h1>路由设置</h1><p>可选择 Codex 订阅或 API 模型作为分配器，审核始终由 Codex Reviewer 完成。</p></div></section>
    <div className="settings-layout"><div className="settings-main">
      {loading ? <div className="settings-card loading-state"><LoaderCircle className="spin" size={21} />正在读取设置…</div> : error && !config ? <div className="alert error"><AlertCircle size={17} /><div><b>设置暂不可用</b><span>{error}</span></div><Button onClick={() => { setLoading(true); api.config().then(c => setConfig(normalizeConfig(c))).catch(e => setError(String(e))).finally(() => setLoading(false)); }}>重试</Button></div> : config && <>
        <section className="settings-card"><div className="settings-card-head"><div className="role-icon codex"><Activity size={18} /></div><div><h2>{allocatorName}分配器</h2><p>{config.allocator.kind === 'api' ? '使用兼容 OpenAI API 的模型决定任务执行路线。' : '使用 Codex 订阅和 Codex CLI 配置决定任务执行路线。'}</p></div><span className="fixed-badge">可切换</span></div>
          <Field label="分配器来源"><Select value={config.allocator.kind} onChange={kind => setConfig(prev => prev ? { ...normalizeConfig(prev), allocator: { ...prev.allocator, kind: kind as Config['allocator']['kind'] } } : prev)} choices={[{ id: 'codex', label: 'Codex 订阅' }, { id: 'api', label: 'API 模型' }]} placeholder="选择分配器" /></Field>
          {config.allocator.kind === 'api' ? <>
            <div className="form-grid" style={{ marginTop: 14 }}><Field label="API HTTPS 地址" hint="必须使用 HTTPS。此处仅配置服务地址。"><input type="url" inputMode="url" pattern="https://.+" title="API 地址必须以 https:// 开头" value={apiAllocatorConfig.baseUrl ?? ''} onChange={e => updateApi('baseUrl', e.target.value)} placeholder="https://api.example.com/v1" /></Field><Field label="API 模型"><input value={apiAllocatorConfig.model ?? ''} onChange={e => updateApi('model', e.target.value)} placeholder="例如 gpt-4.1" /></Field></div>
            <div className="form-grid"><Field label="密钥环境变量名" hint="填写服务端环境变量的名称，例如 ZERO_ALLOCATOR_API_KEY；不要填写密钥值。"><input autoComplete="off" spellCheck={false} value={apiAllocatorConfig.keyEnv ?? ''} onChange={e => updateApi('keyEnv', e.target.value)} placeholder="ZERO_ALLOCATOR_API_KEY" /></Field></div>
          </> : <div className="form-grid" style={{ marginTop: 14 }}><Field label="默认模型"><Select value={config.allocator.modelId || ''} onChange={v => update('allocator', 'modelId', v)} choices={options('allocator', 'models')} placeholder="使用 Codex CLI 默认模型" /></Field><Field label="默认思考强度"><Select value={config.allocator.reasoningEffort || ''} onChange={v => update('allocator', 'reasoningEffort', v)} choices={effortOptions('allocator')} placeholder="使用 Codex CLI 默认值" /></Field></div>}
        </section>
        <section className="settings-card"><div className="settings-card-head"><div className="role-icon reviewer"><ShieldCheck size={18} /></div><div><h2>Codex Reviewer</h2><p>独立只读会话审核改动、测试证据和验收标准。</p></div><span className="fixed-badge">固定 Codex</span></div><div className="form-grid"><Field label="审核模型"><Select value={config.reviewer.modelId || ''} onChange={v => update('reviewer', 'modelId', v)} choices={options('reviewer', 'models')} placeholder="Codex 自动选择" /></Field><Field label="审核思考强度"><Select value={config.reviewer.reasoningEffort || ''} onChange={v => update('reviewer', 'reasoningEffort', v)} choices={effortOptions('reviewer')} placeholder="Codex 自动选择" /></Field></div></section>
        <div className="settings-save-row"><span><ShieldCheck size={14} />界面只保存密钥环境变量名，不读取或保存 API 密钥原文。</span><Button variant="primary" disabled={busy || saved} onClick={() => void save()}>{busy ? <><LoaderCircle size={15} className="spin" />保存中</> : saved ? <><Check size={15} />已保存</> : '保存设置'}</Button></div>{error && <div className="alert error compact"><AlertCircle size={16} />{error}</div>}
      </>}
    </div><aside className="settings-aside"><div className="aside-icon"><ShieldCheck size={19} /></div><h3>选择优先级</h3><p>每个任务的手动指定优先于项目预设与全局预设；未指定字段由 {allocatorName} 补全。</p><div className="priority-stack"><div><span>1</span><b>任务指定</b></div><ArrowDown size={14} /><div><span>2</span><b>项目预设</b></div><ArrowDown size={14} /><div><span>3</span><b>全局预设</b></div><ArrowDown size={14} /><div><span>4</span><b>{allocatorName} 分配</b></div></div><button className="link-button" onClick={() => void onRetry()}><RefreshCw size={13} />刷新能力状态</button></aside></div>
  </>;
}
