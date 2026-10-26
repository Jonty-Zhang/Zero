import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, Search, LayoutList, Columns3, Layers3, AlertCircle, ArrowDown, ArrowRight, ArrowUp, Check, CheckCircle2, ChevronDown, CircleHelp, Clock3, Code2, FileText, FolderGit2, ListOrdered, LoaderCircle, Plus, RefreshCw, Settings2, ShieldCheck, Target, TerminalSquare, X, XCircle } from 'lucide-react';
import { api } from './api';
import { RichText } from './RichText';
import { TaskLead } from './TaskLead';
import { useDialog } from './dialog';
import { BossProjectModal, BossProgress, ProjectDelivery, type BossProjectDraft } from './BossProject';
import { usePolling } from './usePolling';
import type { Capabilities, Choice, Config, ExecutionSelection, HarnessHealth, Status, Task, TaskSequence, TestResult } from './types';

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
const roleLabel = (value?: string) => ({ implement: '执行', revise: '返工', route: '路由', review: '审核' } as Record<string, string>)[value || ''] || nice(value);
const stageStatusLabel = (value: string) => ({ pending: '待处理', running: '执行中', succeeded: '已完成', failed: '失败', interrupted: '已中断' } as Record<string, string>)[value] || nice(value);
const reviewVerdictLabel = (value?: string) => ({ pass: '通过', approved: '通过', changes_requested: '需要修改', blocked: '受阻' } as Record<string, string>)[value || ''] || nice(value);
const date = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未知';
const retryDate = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
const routeName = (route?: Task['route'], fallback = '执行路线未记录') => [route?.harnessId, route?.modelId, route?.reasoningEffort].filter(Boolean).join(' · ') || fallback;
const missingExecutor = (task: Task) => task.status === 'pending' ? '待分配执行 Agent' : '执行 Agent 未记录';
const taskRouteName = (task: Task) => routeName(task.route, missingExecutor(task));
const taskTitle = (task: Task) => task.title || task.prompt?.split('\n')[0]?.slice(0, 72) || `任务 ${task.id.slice(0, 8)}`;
const taskAgents = (task: Task) => [task.route?.harnessId, task.bossPlan?.boss?.harness].filter((value): value is string => Boolean(value));
const sequenceTitle = (sequence: TaskSequence) => {
  const title = sequence.objective?.trim().split(/\r?\n/, 1)[0] || taskTitle(sequence.steps[0]?.task ?? { id: sequence.id, status: 'pending' });
  return title.length > 96 ? `${title.slice(0, 96)}…` : title;
};
type ApiAllocatorConfig = NonNullable<Config['allocator']['api']>;
const emptyApiAllocatorConfig: ApiAllocatorConfig = { baseUrl: null, model: null, keyEnv: null };
const normalizeSelection = (selection: ExecutionSelection | null | undefined): ExecutionSelection | null => {
  const normalized = Object.fromEntries(Object.entries(selection ?? {}).filter(([, value]) => typeof value === 'string' && value.trim())) as ExecutionSelection;
  return Object.keys(normalized).length ? normalized : null;
};
const normalizeConfig = (config: Config): Config => ({
  ...config,
  allocator: { ...config.allocator, api: config.allocator.api ?? { ...emptyApiAllocatorConfig } },
  executionDefaults: {
    global: normalizeSelection(config.executionDefaults?.global),
    projects: (config.executionDefaults?.projects ?? []).map(project => ({ ...project, execution: normalizeSelection(project.execution) ?? {} })),
  },
});

function asTasks(data: unknown): Task[] { return Array.isArray(data) ? data as Task[] : ((data as { tasks?: Task[] })?.tasks ?? []); }
function asSequences(data: TaskSequence[] | { sequences: TaskSequence[] }): TaskSequence[] { return Array.isArray(data) ? data : data.sequences ?? []; }
function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
function Select({ value, onChange, choices, placeholder, disabled }: { value: string; onChange: (v: string) => void; choices: Choice[]; placeholder: string; disabled?: boolean }) {
  return <div className="select-wrap"><select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}><option value="">{placeholder}</option>{value && !choices.some(choice => choice.id === value) && <option value={value} disabled>{value}（当前不可用）</option>}{choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select><ChevronDown size={15} /></div>;
}
function Button({ children, onClick, variant = 'secondary', disabled, type = 'button' }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; disabled?: boolean; type?: 'button' | 'submit' }) {
  return <button className={`button ${variant}`} type={type} onClick={onClick} disabled={disabled}>{children}</button>;
}


const loadTasks = async (_key: string, signal: AbortSignal) => asTasks(await api.tasks({ signal }));
const loadCapabilities = (_key: string, signal: AbortSignal) => api.capabilities({ signal });
const loadSequences = async (_key: string, signal: AbortSignal) => asSequences(await api.sequences({ signal }));
const loadTask = async (id: string, signal: AbortSignal) => { const task = await api.task(id, { signal }); if (task.id !== id) throw new Error('任务身份不匹配，请重新加载'); return task; };
const loadSequence = async (id: string, signal: AbortSignal) => { const result = await api.sequence(id, { signal }); if (result.id !== id) throw new Error('目标身份不匹配，请重新加载'); return result; };

export default function App() {
  const [page, setPage] = useState<'tasks' | 'settings'>('tasks');
  const taskState = usePolling('tasks', loadTasks);
  const capState = usePolling('capabilities', loadCapabilities, 15000);
  const seqState = usePolling('sequences', loadSequences);
  const tasks = taskState.data ?? [];
  const capabilities = capState.data;
  const [allocatorKind, setAllocatorKind] = useState<Config['allocator']['kind']>('codex');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = usePolling(selectedId, loadTask, 3500);
  const [showSubmit, setShowSubmit] = useState(false);
  const [showAdvancedSubmit, setShowAdvancedSubmit] = useState(false);
  const [bossDraft, setBossDraft] = useState<BossProjectDraft | null>(null);
  const [showSequenceSubmit, setShowSequenceSubmit] = useState(false);
  const [selectedSequenceId, setSelectedSequenceId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  const [search, setSearch] = useState(''); const [status, setStatus] = useState('');
  const [repo, setRepo] = useState(''); const [harness, setHarness] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'list' | 'board'>('list');
  const connected = Boolean(taskState.lastSynced && !taskState.error);
  const degraded = connected && Boolean(capState.error || seqState.error);
  const connectionLabel = connected ? degraded ? '部分接口暂不可用' : '本地服务已连接' : taskState.loading ? '正在连接本地服务' : '本地服务未连接';
  useEffect(() => { const controller = new AbortController(); void api.config({ signal: controller.signal }).then(config => { if (!controller.signal.aborted) setAllocatorKind(config.allocator.kind); }).catch(() => {}); return () => controller.abort(); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 3200); return () => clearTimeout(timer); }, [notice]);
  const refreshAll = () => { void taskState.refresh(); void capState.refresh(); void seqState.refresh(); };
  const counts = Object.fromEntries(columns.map(c => [c.id, tasks.filter(t => t.status === c.id).length])) as Record<Status, number>;
  const repos = [...new Set([repo, ...tasks.map(task => task.repoPath)].filter((value): value is string => Boolean(value)))].sort();
  const harnesses = [...new Set([harness, ...tasks.flatMap(taskAgents)].filter(Boolean))].sort();
  const filtered = tasks.filter(task => (!search.trim() || [task.title, task.repoPath, task.id, task.route?.modelId, task.bossPlan?.boss?.model, ...taskAgents(task)].join(' ').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && (!status || task.status === status) && (!repo || task.repoPath === repo) && (!harness || taskAgents(task).includes(harness))).sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  const clearFilters = () => { setSearch(''); setStatus(''); setRepo(''); setHarness(''); searchInput.current?.focus(); };
  return <div className="app-shell">
    <header className="sidebar" aria-label="工作区导航"><button className="brand" onClick={() => setPage('tasks')} aria-label="Zero 首页"><strong>zero<span>.</span></strong></button>
      <nav><button aria-label="任务工作台" aria-current={page === 'tasks' ? 'page' : undefined} className={`nav-item ${page === 'tasks' ? 'active' : ''}`} onClick={() => setPage('tasks')}><LayoutList size={18} /><span className="nav-text">任务工作台</span><span className="nav-count">{tasks.length}</span></button><button aria-label="路由设置" aria-current={page === 'settings' ? 'page' : undefined} className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><Settings2 size={18} /><span className="nav-text">路由设置</span></button></nav>
      <div className={`connection-state ${connected ? 'connected' : ''}`}><div><span className={`pulse-dot ${connected ? '' : 'offline'}`} /><b>{connectionLabel}</b></div></div><button className="icon-button" aria-label="刷新工作区" title="刷新工作区" onClick={refreshAll}><RefreshCw size={18} className={taskState.refreshing ? 'spin' : ''} /></button>
    </header>
    <main className="main-area" tabIndex={-1}>
      {page === 'tasks' ? <><section className="page-heading"><h1>项目</h1><div className="top-actions"><Button onClick={() => setShowSequenceSubmit(true)}><ListOrdered size={17} />高级目标序列</Button><Button variant="primary" onClick={() => setShowSubmit(true)}><Plus size={18} />提交任务</Button></div></section>
        <section className="overview" aria-label="任务概览">{[{ label: '全部任务', count: tasks.length, icon: <Layers3 size={18} />, tone: 'slate' }, { label: '正在进行', count: counts.running + counts.reviewing + counts.revision, icon: <Activity size={18} />, tone: 'blue' }, { label: '需要关注', count: counts.failed + counts.recovery_required, icon: <AlertCircle size={18} />, tone: 'amber' }, { label: '已完成', count: counts.done, icon: <CheckCircle2 size={18} />, tone: 'green' }].map(item => <div key={item.label} className={`overview-card ${item.tone}`} aria-label={`${item.label} ${item.count}`}><div>{item.icon}<span>{item.label}</span></div><strong>{item.count}</strong></div>)}</section>
        <HarnessStrip harnesses={capabilities?.harnesses ?? []} error={capState.error} />
        {(seqState.data?.length || seqState.error) ? <SequenceProgressSection sequences={seqState.data ?? []} error={seqState.error} onOpen={setSelectedSequenceId} onCreate={() => setShowSequenceSubmit(true)} /> : null}
        <section className="task-workspace" aria-label="执行任务"><div className="workspace-heading"><h2>任务 <span>{tasks.length}</span></h2><div className="view-toggle" aria-label="任务视图"><button aria-label="列表视图" aria-pressed={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><LayoutList size={16} />列表</button><button aria-label="看板视图" aria-pressed={view === 'board'} className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><Columns3 size={16} />看板</button></div></div>
          <div className="task-toolbar"><div className="task-search"><Search size={17} /><input ref={searchInput} type="search" aria-label="搜索任务" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); setSearch(''); } }} placeholder="搜索任务、项目或模型…" />{search && <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => { setSearch(''); searchInput.current?.focus(); }}><X size={15} /></button>}</div><select aria-label="状态筛选" value={status} onChange={e => setStatus(e.target.value)}><option value="">全部状态</option>{columns.map(col => <option key={col.id} value={col.id}>{col.label} ({counts[col.id]})</option>)}</select><select aria-label="项目筛选" value={repo} onChange={e => setRepo(e.target.value)}><option value="">全部项目</option>{repos.map(path => <option key={path} value={path}>{path}</option>)}</select><select aria-label="Agent 筛选" value={harness} onChange={e => setHarness(e.target.value)}><option value="">全部 Agent</option>{harnesses.map(id => <option key={id} value={id}>{id}</option>)}</select></div>
          {(search.trim() || status || repo || harness) && <div className="active-filters" role="group" aria-label="当前筛选"><span>找到 {filtered.length} 个任务</span><button type="button" className="link-button" onClick={clearFilters}><X size={14} />清除筛选</button></div>}
          {taskState.error && <div className="alert error" role="alert"><AlertCircle size={17} /><div><b>{taskState.data ? '连接中断，当前显示上次同步的任务' : '无法连接 Zero 服务'}</b><span>{taskState.error}。请确认本地服务已启动。</span></div><button onClick={() => void taskState.refresh()}><RefreshCw size={14} />重试</button></div>}
          {taskState.loading ? <div className="loading-state"><LoaderCircle className="spin" size={24} /><span>正在连接 Zero 服务…</span></div> : !tasks.length ? <div className="empty-state"><div className="empty-icon"><TerminalSquare size={26} /></div><h2>{taskState.error ? '等待本地服务连接' : '准备好开始第一个任务'}</h2><p>{taskState.error ? '连接恢复后，已有任务会显示在这里。' : '选择一个文件夹，写下你的任务。'}</p>{!taskState.error && <Button variant="primary" onClick={() => setShowSubmit(true)}><Plus size={16} />创建第一个任务</Button>}</div> : !filtered.length ? <div className="empty-state filter-empty"><Search size={27} /><h2>没有符合条件的任务</h2><p>试试其他关键词，或清除筛选查看全部任务。</p></div> : view === 'list' ? <TaskTable tasks={filtered} onOpen={setSelectedId} /> : <TaskBoard tasks={filtered} onOpen={setSelectedId} />}
          {!!tasks.length && <div className="table-footer">{filtered.length} / {tasks.length} 个任务</div>}
        </section></> : <SettingsPage capabilities={capabilities} onSaved={(message, kind) => { setAllocatorKind(kind); setNotice({ message }); }} onRetry={capState.refresh} />}
    </main>
    {selectedId && <TaskDrawer onMessage={() => void detail.refresh()} key={selectedId} task={detail.data} loading={detail.loading} loadError={detail.error} onClose={() => setSelectedId(null)} onCancel={async () => { if (!detail.data || detail.data.id !== selectedId) return; await api.cancelTask(detail.data.id); setNotice({ message: '已发送取消请求' }); void detail.refresh(); void taskState.refresh(); }} />}
    {showSubmit && <BossProjectModal capabilities={capabilities} capabilityError={capState.error} initialDraft={bossDraft} onClose={() => { setShowSubmit(false); setBossDraft(null); }} onAdvanced={draft => { setBossDraft(draft); setShowSubmit(false); setShowAdvancedSubmit(true); }} onCreated={task => { setShowSubmit(false); setBossDraft(null); setSelectedId(task.id); setNotice({ message: '项目任务已交给 Boss' }); refreshAll(); }} />}
    {showAdvancedSubmit && <SubmitModal capabilities={capabilities} capabilityError={capState.error} allocatorKind={allocatorKind} initialDraft={bossDraft} onClose={() => setShowAdvancedSubmit(false)} onCreated={task => { setShowAdvancedSubmit(false); setBossDraft(null); setSelectedId(task.id); setNotice({ message: '任务已加入队列' }); refreshAll(); }} />}
    {showSequenceSubmit && <SequenceSubmitModal capabilities={capabilities} onClose={() => setShowSequenceSubmit(false)} onCreated={sequence => { setShowSequenceSubmit(false); setSelectedSequenceId(sequence.id); refreshAll(); }} />}
    {selectedSequenceId && <SequenceDrawer key={selectedSequenceId} id={selectedSequenceId} onClose={() => setSelectedSequenceId(null)} onOpenTask={id => { setSelectedSequenceId(null); setSelectedId(id); }} />}
    {notice && <div className="toast" role="status"><CheckCircle2 size={16} />{notice.message}</div>}
  </div>;
}

function TaskBoard({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const populatedColumns = columns.map(column => ({ ...column, tasks: tasks.filter(task => task.status === column.id) })).filter(column => column.tasks.length > 0);
  return <div className="board">{populatedColumns.map(column => <section className="board-column" key={column.id}>
    <div className="column-heading"><span className={`column-dot ${column.tone}`} /><b>{column.label}</b><span className="column-count">{column.tasks.length}</span></div>
    <div className="cards">{column.tasks.map(task => <TaskCard key={task.id} task={task} onClick={() => onOpen(task.id)} />)}</div>
  </section>)}</div>;
}

function TaskTable({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  return <div className="table-scroll"><table className="task-table"><thead><tr><th>任务</th><th>状态</th><th>执行 Agent</th><th>项目</th><th>最近更新</th><th aria-label="打开任务" /></tr></thead><tbody>{tasks.map(task => <tr key={task.id}><td><button className="task-title-button" onClick={() => onOpen(task.id)}>{taskTitle(task)}</button><TaskLead task={task} /></td><td><span className={`status-pill ${task.status}`}><span />{statusLabel[task.status] || task.status}</span></td><td><div className="table-agent">{task.route?.harnessId && <span className="agent-avatar">{task.route.harnessId.slice(0, 1).toUpperCase()}</span>}<div>{task.route?.harnessId || missingExecutor(task)}{task.route?.modelId && <small>{task.route.modelId}</small>}</div></div></td><td><div className="table-repo" title={task.repoPath}><FolderGit2 size={14} /><span>{task.repoPath?.split(/[\\/]/).filter(Boolean).at(-1) || '未指定'}</span></div>{task.baseRef && <small className="task-id">{task.baseRef}</small>}</td><td className="table-time">{date(task.updatedAt || task.createdAt)}</td><td><button className="icon-button" aria-label={`查看任务 ${taskTitle(task)}`} onClick={() => onOpen(task.id)}><ArrowRight size={16} /></button></td></tr>)}</tbody></table></div>;
}
function HarnessStrip({ harnesses, error }: { harnesses: HarnessHealth[]; error: string }) {
  const order = ['codex', 'dsh', 'zcode'];
  return <section className="harness-strip" aria-label="Agent 连接状态"><div className="strip-title"><div className="strip-icon"><Code2 size={16} /></div><div><b>Agent 连接</b></div></div>
    {error ? <div className="strip-error"><AlertCircle size={15} />能力检查失败：{error}</div> : order.map(id => { const item = harnesses.find(h => h.id.toLowerCase() === id); const name = item?.name || ({ codex: 'Codex', dsh: 'DSH', zcode: 'ZCode' }[id]); return <div className="harness-health" key={id}><span className={`health-indicator ${item?.available ? 'ok' : 'off'}`} /><div><b>{name}</b><small>{item?.available ? '可用' : item?.reason || '未检测到可用配置'}</small></div>{item?.available ? <Check size={14} className="health-check" /> : <CircleHelp size={14} className="health-help" />}</div>; })}
  </section>;
}

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const doneTests = task.tests?.filter(t => t.status === 'passed' || t.status === 'success').length;
  const totalTests = task.tests?.length || 0;
  return <button className="task-card" onClick={onClick}><div className="task-card-top"><span className={`status-pill ${task.status}`}>{statusLabel[task.status] || task.status}</span><span className="task-time">{date(task.updatedAt || task.createdAt)}</span></div><h3>{taskTitle(task)}</h3><TaskLead task={task} /><p className="task-repo"><FolderGit2 size={13} />{task.repoPath || '未指定项目'}{task.baseRef && <span>@ {task.baseRef}</span>}</p>{task.status === 'waiting' && <p className="quota-card-note"><Clock3 size={12} />{retryDate(task.retryAt) ? `预计 ${retryDate(task.retryAt)} 自动重试` : '额度恢复后自动继续'}</p>}<div className="task-card-bottom"><span className="route-chip"><Activity size={12} />{taskRouteName(task)}</span>{totalTests > 0 && <span className="test-count">{doneTests}/{totalTests} 检查</span>}</div></button>;
}

function SequenceProgressSection({ sequences, error, onOpen, onCreate }: { sequences: TaskSequence[]; error: string; onOpen: (id: string) => void; onCreate: () => void }) {
  if (!sequences.length && !error) return <section className="sequence-section"><div className="sequence-section-heading"><div><h2><Target size={16} />目标序列</h2><p>把一个目标拆成至少两个按顺序执行的任务。</p></div><Button onClick={onCreate}><ListOrdered size={14} />提交目标</Button></div></section>;
  return <section className="sequence-section"><div className="sequence-section-heading"><div><h2><Target size={16} />目标序列</h2><p>按顺序查看目标拆解任务的进度。</p></div><Button onClick={onCreate}><ListOrdered size={14} />提交目标</Button></div>
    {error && <div className="alert error compact" role="alert"><AlertCircle size={15} /><div>{sequences.length > 0 && <b>刷新失败，显示上次同步的目标</b>}<span>{error}</span></div></div>}
    {sequences.length > 0 && <div className="sequence-list">{sequences.map(sequence => {
      const completed = sequence.steps.filter(step => step.task.status === 'done').length;
      const activeGoalRevision = activeGoalRevisionTask(sequence);
      const allStepsDone = sequence.steps.length > 0 && completed === sequence.steps.length;
      const hasGoalRevisionSteps = sequence.goalRevisionCount > 0;
      const goalCapExhausted = allStepsDone && !activeGoalRevision && sequence.goalReview?.state === 'verdict' && sequence.goalReview.result?.verdict === 'changes_requested' && sequence.goalRevisionCount >= sequence.maxGoalRevisions;
      return <button className="sequence-card" key={sequence.id} onClick={() => onOpen(sequence.id)}><div className="sequence-card-head"><b>{sequenceTitle(sequence)}</b><span className={`sequence-state ${sequence.status}`}>{sequenceStatusLabel[sequence.status]}</span></div><div className="sequence-card-meta">{completed}/{sequence.steps.length} 步骤已完成 · 更新于 {date(sequence.updatedAt)}</div><div className="sequence-mini-steps">{sequence.steps.map(step => <span key={step.task.id} className={step.task.status === 'done' ? 'done' : step.task.status === 'failed' || step.task.status === 'recovery_required' ? 'blocked' : ''}>{step.position + 1}. {taskTitle(step.task)}</span>)}</div>
        <div className="sequence-card-meta">自动目标返工 {sequence.goalRevisionCount}/{sequence.maxGoalRevisions}</div>
        {sequence.status === 'steps_completed' && <div className="sequence-goal-note"><AlertCircle size={14} />所有步骤已完成；目标级 Codex 验收尚未完成。</div>}
        {hasGoalRevisionSteps && sequence.goalReview?.state === 'verdict' && sequence.goalReview.result?.verdict === 'changes_requested' && activeGoalRevision ? <div className="sequence-goal-note"><Activity size={14} />上次目标验收要求修改，自动返工正在处理；该结果不是当前最终状态。</div> : hasGoalRevisionSteps && sequence.goalReview?.state === 'verdict' && sequence.goalReview.result?.verdict === 'changes_requested' && allStepsDone && !goalCapExhausted ? <div className="sequence-goal-note"><Activity size={14} />返工步骤已完成；最新验收仍要求修改，下一轮自动返工正在排队。</div> : hasGoalRevisionSteps && sequence.goalReview?.state === 'verdict' && sequence.goalReview.result?.verdict === 'changes_requested' && !allStepsDone ? <div className="sequence-goal-note"><AlertCircle size={14} />上一轮目标验收要求修改；自动返工步骤未能完成，请查看步骤状态。</div> : sequence.goalReview?.state === 'verdict' && <div className="sequence-goal-note">{sequence.goalReview.result?.verdict === 'pass' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}目标验收 {sequence.goalReview.result?.verdict?.toUpperCase() || '已完成'}：{sequence.goalReview.result?.summary}</div>}
        {goalCapExhausted && <div className="sequence-goal-note"><AlertCircle size={14} />自动目标返工额度已用完（{sequence.goalRevisionCount}/{sequence.maxGoalRevisions}）；序列保持阻塞。原因：{sequence.blockedReason?.reason || '整体目标验收仍未通过。'}</div>}
        {sequence.goalReview?.state === 'quota' && <div className="sequence-goal-note"><Clock3 size={14} />目标验收等待额度恢复{sequence.goalReview.retryAt ? `，计划重试时间：${date(sequence.goalReview.retryAt)}` : ''}</div>}
        {sequence.goalReview?.state === 'running' && <div className="sequence-goal-note"><Activity size={14} />正在进行目标级 Codex 验收。</div>}
        {sequence.status === 'completed' && !sequence.goalReview && <div className="sequence-goal-note"><CheckCircle2 size={14} />所有步骤已完成；未配置额外的目标级验收条件。</div>}
      </button>;
    })}</div>}
  </section>;
}

type SequenceStepDraft = { repoPath: string; baseRef: string; prompt: string; criteria: string; checks: string; harnessId: string; modelId: string; reasoningEffort: string };
function resolveSequenceStepRepository(step: Pick<SequenceStepDraft, 'repoPath' | 'baseRef'>, defaultRepoPath: string, defaultBaseRef: string): { repoPath: string; baseRef: string } {
  return { repoPath: step.repoPath.trim() || defaultRepoPath.trim(), baseRef: step.baseRef.trim() || defaultBaseRef.trim() || 'HEAD' };
}
function isGoalRevisionStep(sequence: TaskSequence, index: number) {
  return sequence.goalRevisionCount > 0 && index >= Math.max(0, sequence.steps.length - sequence.goalRevisionCount);
}
function activeGoalRevisionTask(sequence: TaskSequence) {
  return sequence.steps.find((step, index) => isGoalRevisionStep(sequence, index) && ['pending', 'running', 'reviewing', 'revision', 'waiting'].includes(step.task.status));
}
function SequenceSubmitModal({ capabilities, onClose, onCreated }: { capabilities: Capabilities | null; onClose: () => void; onCreated: (sequence: TaskSequence) => void }) {
  const [repoPath, setRepoPath] = useState(''); const [baseRef, setBaseRef] = useState('HEAD'); const [objective, setObjective] = useState(''); const [goalCriteria, setGoalCriteria] = useState('');
  const [maxRevisions, setMaxRevisions] = useState(2); const [maxGoalRevisions, setMaxGoalRevisions] = useState(2);
  const blankStep = (): SequenceStepDraft => ({ repoPath: '', baseRef: '', prompt: '', criteria: '', checks: '', harnessId: '', modelId: '', reasoningEffort: '' });
  const [steps, setSteps] = useState<SequenceStepDraft[]>([blankStep(), blankStep()]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const dialogRef = useDialog(onClose, busy);
  const bindings = useMemo(() => (capabilities?.bindings ?? []).filter(binding => binding.available && capabilities?.harnesses.some(harness => harness.id === binding.harnessId && harness.available)), [capabilities]);
  const harnessChoices = [...new Map(bindings.map(binding => [binding.harnessId, binding])).values()].map(binding => ({ id: binding.harnessId, label: capabilities?.harnesses.find(harness => harness.id === binding.harnessId)?.name || binding.harnessId }));
  const updateStep = (index: number, key: keyof SequenceStepDraft, value: string) => setSteps(current => current.map((step, i) => i === index ? { ...step, [key]: value, ...(key === 'harnessId' ? { modelId: '', reasoningEffort: '' } : key === 'modelId' ? { reasoningEffort: '' } : {}) } : step));
  const repositories = steps.map(step => resolveSequenceStepRepository(step, repoPath, baseRef));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setError('');
    if (repositories.some(repository => !repository.repoPath)) return;
    if (steps.length < 2 || steps.some(step => step.prompt.trim().length < 8 || !step.checks.trim())) { setError('至少需要两个步骤，每个步骤的描述至少填写 8 个字符，并提供检查命令。'); return; }
    for (const [index, step] of steps.entries()) {
      const candidates = bindings.filter(binding => (!step.harnessId || binding.harnessId === step.harnessId) && (!step.modelId || binding.modelId === step.modelId));
      if ((step.harnessId || step.modelId || step.reasoningEffort) && !candidates.length) { setError(`步骤 ${index + 1} 的 Harness 与模型没有通过验证的可用组合。`); return; }
      if (step.reasoningEffort && !candidates.some(binding => binding.reasoningEfforts?.some(choice => choice.id === step.reasoningEffort))) { setError(`步骤 ${index + 1} 的思考强度与 Harness、模型组合不匹配。`); return; }
    }
    setBusy(true);
    try {
      const created = await api.createSequence({ ...(objective.trim() ? { objective: objective.trim() } : {}), ...(goalCriteria.trim() ? { acceptanceCriteria: goalCriteria.split('\n').map(line => line.trim()).filter(Boolean) } : {}), maxGoalRevisions, tasks: steps.map((step, index) => ({ ...repositories[index]!, prompt: step.prompt.trim(), acceptanceCriteria: step.criteria.trim(), checkCommands: step.checks.split('\n').map(line => line.trim()).filter(Boolean), maxRevisions, execution: { harnessId: step.harnessId || null, modelId: step.modelId || null, reasoningEffort: step.reasoningEffort || null } })) });
      onCreated(created);
    } catch (e) { setError(e instanceof Error ? e.message : '目标提交失败，请稍后重试'); }
    finally { setBusy(false); }
  };
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}><section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="提交有序任务序列" className="modal submit-modal sequence-submit-modal"><div className="modal-heading"><div><h2>提交有序任务序列</h2><p>步骤按顺序执行；同一规范仓库的后续步骤接续已验证结果，不同仓库分别维护历史。</p></div><button className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={submit} className="submit-form"><fieldset disabled={busy}><div className="form-grid"><Field label="默认仓库路径" hint="步骤仓库留空时继承；每步均指定仓库时此处可留空"><input value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder="例如 C:\\projects\\my-app" /></Field><Field label="默认基础 Ref" hint="步骤 Ref 留空时继承；此处留空使用 HEAD"><input value={baseRef} onChange={e => setBaseRef(e.target.value)} placeholder="HEAD" /></Field></div>
      <Field label="整体目标" hint="可选；留空时按步骤完成情况结束序列。"><input value={objective} onChange={e => setObjective(e.target.value)} placeholder="例如：为服务添加可靠的登录与账户管理" /></Field>
      <Field label="目标级验收标准" hint="可选，逐行填写。这些标准不会由单个步骤的完成状态自动判定。"><textarea rows={2} value={goalCriteria} onChange={e => setGoalCriteria(e.target.value)} placeholder="列出需要整体评估的目标条件" /></Field>
      <div className="form-grid"><Field label="每个步骤的最大返工次数" hint="单个任务执行时允许的内容返工次数"><input type="number" min="0" max="10" value={maxRevisions} onChange={e => setMaxRevisions(Number(e.target.value))} /></Field><Field label="自动目标返工上限" hint="整体目标验收要求修改后，最多自动追加的返工任务数（0–5）"><input type="number" min="0" max="5" value={maxGoalRevisions} onChange={e => setMaxGoalRevisions(Math.max(0, Math.min(5, Number(e.target.value))))} /></Field></div>
      <div className="section-divider"><span>按顺序执行的步骤</span><span>至少 2 步，可分别指定仓库与基础 Ref</span></div>
      {steps.map((step, index) => {
        const stepBindings = bindings.filter(binding => !step.harnessId || binding.harnessId === step.harnessId);
        const modelChoices = [...new Map(stepBindings.map(binding => [binding.modelId, binding])).values()].map(binding => ({ id: binding.modelId, label: binding.modelName || binding.modelId }));
        const matchingBindings = stepBindings.filter(binding => !step.modelId || binding.modelId === step.modelId);
        const effortChoices = step.modelId ? [...new Map(matchingBindings.flatMap(binding => binding.reasoningEfforts ?? []).map(choice => [choice.id, choice])).values()] : [];
        const repository = repositories[index]!;
        const repositoryErrorId = `sequence-repository-error-${index}`;
        return <section className="sequence-step-editor" key={index}><div className="execution-stage-title"><b>步骤 {index + 1}</b><div className="stage-actions"><button type="button" className="link-button" aria-label={`将步骤 ${index + 1} 上移`} title="上移" disabled={index === 0} onClick={() => setSteps(current => current.map((item, i) => i === index - 1 ? current[index]! : i === index ? current[index - 1]! : item))}><ArrowUp size={13} /></button><button type="button" className="link-button" aria-label={`将步骤 ${index + 1} 下移`} title="下移" disabled={index === steps.length - 1} onClick={() => setSteps(current => current.map((item, i) => i === index ? current[index + 1]! : i === index + 1 ? current[index]! : item))}><ArrowDown size={13} /></button><button type="button" className="link-button" disabled={steps.length <= 2} onClick={() => setSteps(current => current.filter((_, i) => i !== index))}><X size={13} />移除</button></div></div>
        <div className="form-grid"><Field label={`步骤 ${index + 1} 仓库路径`} hint="留空继承默认仓库路径"><input value={step.repoPath} onChange={e => updateStep(index, 'repoPath', e.target.value)} aria-invalid={!repository.repoPath || undefined} aria-describedby={!repository.repoPath ? repositoryErrorId : undefined} placeholder="可选，覆盖本步骤的仓库" /></Field><Field label={`步骤 ${index + 1} 基础 Ref`} hint="留空继承默认基础 Ref"><input value={step.baseRef} onChange={e => updateStep(index, 'baseRef', e.target.value)} placeholder="可选，覆盖本步骤的 Ref" /></Field></div>
        <div className="sequence-repository-preview"><span>生效仓库：<code>{repository.repoPath || '待填写'}</code></span><span>配置基础 Ref：<code>{repository.baseRef}</code></span></div>
        {!repository.repoPath && <p id={repositoryErrorId} className="sequence-repository-error" role="status">步骤 {index + 1} 缺少仓库路径：请填写默认仓库路径或本步骤仓库路径。</p>}
        <Field label={`步骤 ${index + 1} 描述 *`}><textarea required minLength={8} rows={3} value={step.prompt} onChange={e => updateStep(index, 'prompt', e.target.value)} placeholder="描述这一阶段要实现或验证的内容" /></Field>
        <div className="form-grid"><Field label="步骤验收标准" hint="可选，逐行填写"><textarea rows={2} value={step.criteria} onChange={e => updateStep(index, 'criteria', e.target.value)} placeholder="此步骤需要满足的条件" /></Field><Field label="检查命令 *" hint="必填，每行一条。没有检查命令将无法通过验收。"><textarea required rows={2} value={step.checks} onChange={e => updateStep(index, 'checks', e.target.value)} placeholder={'例如\nnpm test'} /></Field></div>
        <div className="form-grid three"><Field label="Harness"><Select value={step.harnessId} onChange={value => updateStep(index, 'harnessId', value)} choices={harnessChoices} placeholder="继承或自动选择" /></Field><Field label="模型"><Select value={step.modelId} onChange={value => updateStep(index, 'modelId', value)} choices={modelChoices} placeholder="继承或自动选择" disabled={!capabilities || !stepBindings.length} /></Field><Field label="思考强度"><Select value={step.reasoningEffort} onChange={value => updateStep(index, 'reasoningEffort', value)} choices={effortChoices} placeholder="继承或自动选择" disabled={!step.modelId || effortChoices.length === 0} /></Field></div>
      </section>;
      })}
      <Button onClick={() => setSteps(current => current.length < 16 ? [...current, blankStep()] : current)} disabled={steps.length >= 16}><Plus size={14} />添加步骤</Button>
      {capabilities && bindings.length > 0 ? <div className="inline-info sequence-allocator-note"><Activity size={14} />每个步骤可单独指定 Harness、模型和思考强度；留空字段先继承项目/全局预设，再由分配器补全。</div> : <div className="inline-warning sequence-allocator-note"><AlertCircle size={14} />当前没有可用的已验证执行组合；留空字段仍会先继承项目/全局预设，再交由分配器选择。</div>}
      {error && <div className="alert error compact"><AlertCircle size={16} />{error}</div>}<div className="modal-footer"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy || repositories.some(repository => !repository.repoPath) || steps.some(step => step.prompt.trim().length < 8 || !step.checks.trim())}>{busy ? <><LoaderCircle size={15} className="spin" />正在提交</> : <><ListOrdered size={16} />提交目标序列</>}</Button></div>
    </fieldset></form></section></div>;
}

function SequenceDrawer({ id, onClose, onOpenTask }: { id: string; onClose: () => void; onOpenTask: (taskId: string) => void }) {
  const state = usePolling(id, loadSequence);
  const sequence = state.data; const error = state.error;
  const [retryBusyAttempt, setRetryBusyAttempt] = useState<string | null>(null);
  const [retryFailure, setRetryFailure] = useState<{ attemptId: string; message: string } | null>(null);
  const retryOperation = useRef(0);
  const [acknowledgedAttempt, setAcknowledgedAttempt] = useState<string | null>(null);
  const dialogRef = useDialog(onClose);
  const status = sequence?.status;
  const allStepsDone = Boolean(sequence && sequence.steps.length > 0 && sequence.steps.every(step => step.task.status === 'done'));
  const activeGoalRevision = sequence ? activeGoalRevisionTask(sequence) : undefined;
  const hasGoalRevisionSteps = Boolean(sequence && sequence.goalRevisionCount > 0);
  const targetStep = sequence?.goalReview?.result?.verdict === 'changes_requested'
    ? sequence.steps.find(step => step.task.id === sequence.goalReview?.result?.targetTaskId) : undefined;
  const goalCapExhausted = Boolean(sequence && allStepsDone && !activeGoalRevision && sequence.goalReview?.state === 'verdict' && sequence.goalReview.result?.verdict === 'changes_requested' && sequence.goalRevisionCount >= sequence.maxGoalRevisions);
  const retryEligible = Boolean(sequence && allStepsDone && (sequence.objective || sequence.acceptanceCriteria?.length)
    && sequence.goalReview?.state === 'verdict' && sequence.goalReview.result?.verdict === 'blocked' && sequence.goalReview.attemptId);
  const retryBusy = Boolean(retryBusyAttempt && retryBusyAttempt === sequence?.goalReview?.attemptId);
  const retryError = retryEligible && retryFailure?.attemptId === sequence?.goalReview?.attemptId ? retryFailure?.message : undefined;
  const retryQueued = Boolean(sequence?.goalReview?.retryRequestedAt || sequence?.goalReview?.attemptId && acknowledgedAttempt === sequence.goalReview.attemptId);
  const retryGoalReview = async () => {
    const attemptId = sequence?.goalReview?.attemptId;
    if (!retryEligible || !attemptId || retryBusy || retryQueued) return;
    const operation = ++retryOperation.current;
    setRetryBusyAttempt(attemptId); setRetryFailure(null);
    try { await api.retrySequenceGoalReview(id, attemptId); if (operation === retryOperation.current) setAcknowledgedAttempt(attemptId); }
    catch (error) { if (operation === retryOperation.current) setRetryFailure({ attemptId, message: error instanceof Error ? error.message : '重新验收请求失败，请稍后重试' }); }
    finally { if (operation === retryOperation.current) { setRetryBusyAttempt(null); void state.refresh(); } }
  };
  return <div className="drawer-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><aside ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="目标进度" className="task-drawer sequence-drawer"><header className="drawer-header"><div><div className="eyebrow">目标进度</div><h2>{sequence ? sequenceTitle(sequence) : '正在读取目标'}</h2></div><button className="icon-button" aria-label="关闭详情" onClick={onClose}><X size={18} /></button></header>
    {error && !sequence ? <div className="alert error"><AlertCircle size={17} /><div><b>目标读取失败</b><span>{error}</span></div></div> : !sequence ? <div className="loading-state"><LoaderCircle className="spin" size={22} />正在读取目标进度…</div> : <div className="drawer-content">{error && <div className="alert stale-banner" role="alert">刷新失败，显示上次同步内容：{error}</div>}
      <div className="drawer-status-row"><span className={`sequence-state ${status}`}>{sequenceStatusLabel[sequence.status]}</span><span className="muted">{sequence.steps.filter(step => step.task.status === 'done').length}/{sequence.steps.length} 步骤已完成 · 自动目标返工 {sequence.goalRevisionCount}/{sequence.maxGoalRevisions}</span></div>
      {sequence.status === 'steps_completed' && <section className="sequence-goal-callout pending"><Target size={17} /><div><b>步骤已完成，等待目标级 Codex 验收</b><p>步骤完成本身不代表整体目标已通过。</p></div></section>}
      {sequence.goalReview?.state === 'running' && <section className="sequence-goal-callout pending"><Activity size={17} /><div><b>正在进行目标级 Codex 验收</b><p>验收根据完整序列结果和目标条件进行。</p></div></section>}
      {sequence.goalReview?.state === 'quota' && <section className="sequence-goal-callout pending"><Clock3 size={17} /><div><b>目标级验收等待额度恢复</b><p>{sequence.goalReview.retryAt ? `计划重试时间：${date(sequence.goalReview.retryAt)}` : '额度恢复后将重试。'}</p></div></section>}
      {sequence.goalReview?.state === 'verdict' && <section className={`sequence-goal-callout ${sequence.goalReview.result?.verdict === 'pass' ? 'done' : 'pending'}`}><Target size={17} /><div><b>{hasGoalRevisionSteps && sequence.goalReview.result?.verdict === 'changes_requested' ? '上一轮目标验收：CHANGES_REQUESTED' : `目标验收：${sequence.goalReview.result?.verdict?.toUpperCase() || '未知'}`}</b><p>{sequence.goalReview.result?.summary}</p>{activeGoalRevision && sequence.goalReview.result?.verdict === 'changes_requested' && <p>自动目标返工正在处理；上方结果属于上一轮验收，不代表当前最终状态。</p>}{hasGoalRevisionSteps && !activeGoalRevision && allStepsDone && !goalCapExhausted && sequence.goalReview.result?.verdict === 'changes_requested' && <p>返工步骤已完成；最新验收仍要求修改，下一轮自动返工正在排队。</p>}{hasGoalRevisionSteps && !activeGoalRevision && !allStepsDone && sequence.goalReview.result?.verdict === 'changes_requested' && <p>上一轮验收要求的自动返工步骤未能完成；请查看步骤状态和错误详情。</p>}{goalCapExhausted && <p>自动目标返工额度已用完（{sequence.goalRevisionCount}/{sequence.maxGoalRevisions}），序列保持阻塞。原因：{sequence.blockedReason?.reason || '整体目标验收仍未通过。'}</p>}{sequence.goalReview.result?.verdict !== 'pass' && !activeGoalRevision && !goalCapExhausted && !hasGoalRevisionSteps && <p>请依据以下发现处理。</p>}{sequence.goalReview.result?.findings?.length ? <ul className="sequence-criteria">{sequence.goalReview.result.findings.map((finding, index) => <li key={index}><b>{finding.severity || 'finding'}</b>{finding.file ? ` · ${finding.file}${finding.line ? `:${finding.line}` : ''}` : ''} — {finding.message}</li>)}</ul> : null}</div></section>}
      {targetStep && <section className="sequence-goal-target" aria-label="本轮返工目标"><div><span className="sub-label">本轮返工目标 · 步骤 {targetStep.position + 1}</span><b>{taskTitle(targetStep.task)}</b><code>{targetStep.task.repoPath}</code></div><Button onClick={() => onOpenTask(targetStep.task.id)}><ArrowRight size={13} />查看目标步骤</Button></section>}
      {retryEligible && <div className="sequence-goal-callout pending"><RefreshCw size={17} /><div><Button disabled={retryBusy || retryQueued} onClick={() => void retryGoalReview()}>{retryBusy ? '正在提交重新验收…' : '重新验收'}</Button>{retryQueued && <p role="status">重新验收已排队；上一轮验收结果保留，等待新的验收开始。</p>}</div></div>}
      {retryError && <div className="alert error compact" role="alert"><AlertCircle size={15} />{retryError}</div>}
      {sequence.status === 'completed' && !sequence.goalReview && <section className="sequence-goal-callout done"><CheckCircle2 size={17} /><div><b>序列已完成</b><p>所有任务步骤已完成；此序列未配置额外的目标级验收条件。</p></div></section>}
      {sequence.blockedReason && <div className="alert error compact"><AlertCircle size={15} /><span>{goalCapExhausted || allStepsDone && sequence.goalReview?.state === 'verdict' && sequence.goalReview.result?.verdict !== 'pass' ? '目标验收受阻' : '步骤受阻'}：{sequence.blockedReason.reason || statusLabel[sequence.blockedReason.status] || sequence.blockedReason.status}</span></div>}
      {sequence.objective && <div className="detail-block"><h3><Target size={15} />整体目标</h3><p className="pre-wrap">{sequence.objective}</p></div>}
      {sequence.acceptanceCriteria?.length ? <div className="detail-block"><h3><Target size={15} />目标级验收标准</h3><ul className="sequence-criteria">{sequence.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></div> : null}
      <div className="detail-block"><h3><ListOrdered size={15} />有序步骤 <span className="count-badge">{sequence.steps.length}</span></h3><div className="sequence-detail-steps">{sequence.steps.map((step, index) => <article className="sequence-detail-step" key={step.task.id}><div className="sequence-detail-step-head"><span className={`sequence-step-number ${step.task.status}`}>{step.position + 1}</span><b>{taskTitle(step.task)}</b>{isGoalRevisionStep(sequence, index) && <span className="count-badge">自动目标返工</span>}<span className={`status-pill ${step.task.status}`}>{statusLabel[step.task.status] || step.task.status}</span></div>{step.task.repoPath && <div className="sequence-step-repository"><FolderGit2 size={12} /><code>{step.task.repoPath}</code></div>}{(step.task.error || step.task.recoveryReason) && <p>{step.task.error || step.task.recoveryReason}</p>}<Button onClick={() => onOpenTask(step.task.id)}><ArrowRight size={13} />查看步骤任务</Button></article>)}</div></div>
    </div>}</aside></div>;
}

function SubmitModal({ capabilities, capabilityError, allocatorKind, initialDraft, onClose, onCreated }: { capabilities: Capabilities | null; capabilityError: string; allocatorKind: Config['allocator']['kind']; initialDraft?: Pick<BossProjectDraft, 'path' | 'prompt'> | null; onClose: () => void; onCreated: (task: Task) => void }) {
  const [repoPath, setRepoPath] = useState(initialDraft?.path ?? ''); const [baseRef, setBaseRef] = useState('HEAD'); const [prompt, setPrompt] = useState(initialDraft?.prompt ?? ''); const [criteria, setCriteria] = useState(''); const [maxRevisions, setMaxRevisions] = useState(2); const [checks, setChecks] = useState('');
  const [harnessId, setHarnessId] = useState(''); const [modelId, setModelId] = useState(''); const [effort, setEffort] = useState('');
  const [stages, setStages] = useState<Array<{ harnessId: string; modelId: string; reasoningEffort: string; objective: string }>>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const dialogRef = useDialog(onClose, busy);
  const bindings = useMemo(() => (capabilities?.bindings ?? []).filter(b => b.available && capabilities?.harnesses.some(h => h.id === b.harnessId && h.available)), [capabilities]);
  const filteredBindings = bindings.filter(b => !harnessId || b.harnessId === harnessId);
  const harnessChoices = [...new Map(bindings.map(b => [b.harnessId, b])).values()].map(b => ({ id: b.harnessId, label: capabilities?.harnesses.find(h => h.id === b.harnessId)?.name || b.harnessId }));
  const modelChoices = [...new Map(filteredBindings.map(b => [b.modelId, b])).values()].map(b => ({ id: b.modelId, label: b.modelName || b.modelId }));
  const effortChoices = modelId ? [...new Map(filteredBindings.filter(b => b.modelId === modelId).flatMap(b => b.reasoningEfforts ?? []).map(e => [e.id, e])).values()] : [];
  const submit = async (event: FormEvent) => { event.preventDefault(); if (busy) return; if (!checks.trim()) { setError('请至少填写一条检查命令。'); return; } setError(''); setBusy(true); try { const created = await api.createTask({ repoPath: repoPath.trim(), baseRef: baseRef.trim() || null, prompt: prompt.trim(), acceptanceCriteria: criteria.trim(), maxRevisions, checkCommands: checks.split('\n').map(s => s.trim()).filter(Boolean), execution: { harnessId: harnessId || null, modelId: modelId || null, reasoningEffort: effort || null }, ...(stages.length ? { executionStages: stages.map(stage => ({ ...(stage.objective.trim() ? { objective: stage.objective.trim() } : {}), ...(stage.harnessId ? { harnessId: stage.harnessId } : {}), ...(stage.modelId ? { modelId: stage.modelId } : {}), ...(stage.reasoningEffort ? { reasoningEffort: stage.reasoningEffort } : {}) })) } : {}) }); onCreated(created); } catch (e) { setError(e instanceof Error ? e.message : '提交失败，请稍后重试'); } finally { setBusy(false); } };
  const allocatorName = allocatorKind === 'api' ? 'API 模型' : 'Codex';
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}><section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="提交执行任务" className="modal submit-modal"><div className="modal-heading"><div><h2>提交执行任务</h2><p>留空的执行选项由 {allocatorName} 分配。</p></div><button className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={submit} className="submit-form"><fieldset disabled={busy}><div className="form-grid"><Field label="仓库路径 *" hint="本机 Git 仓库的绝对路径"><input required value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder="例如 C:\\projects\\my-app" /></Field><Field label="基础分支 / Ref"><input value={baseRef} onChange={e => setBaseRef(e.target.value)} placeholder="HEAD" /></Field></div>
      <Field label="任务描述 *"><textarea required minLength={8} rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述要实现或修复的内容、相关背景和约束…" /></Field><Field label="验收标准" hint="逐行填写，系统会交给执行器与 Reviewer"><textarea rows={3} value={criteria} onChange={e => setCriteria(e.target.value)} placeholder={'例如：\n- 登录失败时显示明确错误\n- 原有测试保持通过'} /></Field>
      <div className="section-divider"><span>执行偏好</span><span>每项可单独留空</span></div>
      <div className="form-grid three"><Field label="Harness"><Select value={harnessId} onChange={v => { setHarnessId(v); setModelId(''); setEffort(''); }} choices={harnessChoices} placeholder="继承或自动选择" /></Field><Field label="模型"><Select value={modelId} onChange={v => { setModelId(v); setEffort(''); }} choices={modelChoices} placeholder="继承或自动选择" disabled={!capabilities || !bindings.length} /></Field><Field label="思考强度"><Select value={effort} onChange={setEffort} choices={effortChoices} placeholder="继承或自动选择" disabled={!modelId || effortChoices.length === 0} /></Field></div>
      <div className="stage-editor-head"><div><b>执行阶段</b><span>按顺序接力，可分别指定 Agent 与目标</span></div><Button onClick={() => setStages(current => current.length < 16 ? [...current, { harnessId: '', modelId: '', reasoningEffort: '', objective: '' }] : current)} disabled={stages.length >= 16}><Plus size={14} />添加阶段</Button></div>
      {stages.map((stage, index) => {
        const effectiveHarness = stage.harnessId || harnessId;
        const effectiveModel = stage.modelId || modelId;
        const stageBindings = bindings.filter(binding => !effectiveHarness || binding.harnessId === effectiveHarness);
        const stageModels = [...new Map(stageBindings.map(binding => [binding.modelId, binding])).values()].map(binding => ({ id: binding.modelId, label: binding.modelName || binding.modelId }));
        const matchingStageBindings = bindings.filter(binding => (!effectiveHarness || binding.harnessId === effectiveHarness) && (!effectiveModel || binding.modelId === effectiveModel));
        const stageEfforts = [...new Map(matchingStageBindings.flatMap(binding => binding.reasoningEfforts ?? []).map(choice => [choice.id, choice])).values()];
        const updateStage = (key: 'harnessId' | 'modelId' | 'reasoningEffort' | 'objective', value: string) => setStages(current => current.map((item, i) => i === index ? { ...item, [key]: value, ...(key === 'harnessId' ? { modelId: '', reasoningEffort: '' } : key === 'modelId' ? { reasoningEffort: '' } : {}) } : item));
        return <div className="execution-stage" key={index}><div className="execution-stage-title"><b>阶段 {index + 1}</b><div className="stage-actions"><button type="button" className="link-button" aria-label={`将阶段 ${index + 1} 上移`} title="上移" disabled={index === 0} onClick={() => setStages(current => current.map((item, i) => i === index - 1 ? current[index]! : i === index ? current[index - 1]! : item))}><ArrowUp size={13} /></button><button type="button" className="link-button" aria-label={`将阶段 ${index + 1} 下移`} title="下移" disabled={index === stages.length - 1} onClick={() => setStages(current => current.map((item, i) => i === index ? current[index + 1]! : i === index + 1 ? current[index]! : item))}><ArrowDown size={13} /></button><button type="button" className="link-button" aria-label={`移除阶段 ${index + 1}`} onClick={() => setStages(current => current.filter((_, i) => i !== index))}><X size={13} />移除</button></div></div><Field label={`阶段 ${index + 1} 目标`}><textarea rows={2} maxLength={4000} value={stage.objective} onChange={event => updateStage('objective', event.target.value)} placeholder="可选；说明此 Agent 需要完成的工作，留空沿用整体任务" /></Field><div className="form-grid three"><Field label="Harness"><Select value={stage.harnessId} onChange={v => updateStage('harnessId', v)} choices={harnessChoices} placeholder="继承或自动选择" /></Field><Field label="模型"><Select value={stage.modelId} onChange={v => updateStage('modelId', v)} choices={stageModels} placeholder="继承或自动选择" disabled={!capabilities || !bindings.length} /></Field><Field label="思考强度"><Select value={stage.reasoningEffort} onChange={v => updateStage('reasoningEffort', v)} choices={stageEfforts} placeholder="继承或自动选择" disabled={stageEfforts.length === 0} /></Field></div></div>;
      })}
      {capabilityError ? <div className="inline-warning"><AlertCircle size={15} />暂时无法验证执行能力，建议刷新后再提交。已选执行项仍会保留；可用性由服务端再次验证。</div> : !bindings.length ? <div className="inline-warning"><AlertCircle size={15} />当前没有通过能力验证的执行组合，执行选项不可手动选择。</div> : null}
      <div className="form-grid lower-grid"><Field label="最大返工次数"><input type="number" min="0" max="10" value={maxRevisions} onChange={e => setMaxRevisions(Number(e.target.value))} /></Field><Field label="检查命令 *" hint="必填，每行一条。由 Zero 执行，作为完成门禁。"><textarea required rows={2} value={checks} onChange={e => setChecks(e.target.value)} placeholder={'例如\nnpm test\nnpm run build'} /></Field></div>
      {error && <div className="alert error compact"><AlertCircle size={16} />{error}</div>}<div className="modal-footer"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy || !repoPath.trim() || prompt.trim().length < 8 || !checks.trim()}>{busy ? <><LoaderCircle size={15} className="spin" />正在提交</> : <><Plus size={16} />加入任务队列</>}</Button></div>
    </fieldset></form></section></div>;
}

function TaskDrawer({ task, loading, loadError, onClose, onCancel, onMessage }: { onMessage: () => void; task: Task | null; loading: boolean; loadError: string; onClose: () => void; onCancel: () => Promise<void> }) {
  const [cancelBusy, setCancelBusy] = useState(false); const [cancelError, setCancelError] = useState('');
  const dialogRef = useDialog(onClose);
  const cancel = async () => { setCancelBusy(true); setCancelError(''); try { await onCancel(); } catch (e) { setCancelError(e instanceof Error ? e.message : '取消请求失败'); } finally { setCancelBusy(false); } };
  const attempts = task?.attempts ?? [];
  const logs = Array.isArray(task?.logs) ? task?.logs.join('\n') : task?.logs;
  const canCancel = Boolean(task && ['pending', 'running', 'reviewing', 'revision', 'waiting'].includes(task.status));
  return <div className="drawer-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><aside ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="任务详情" className="task-drawer"><header className="drawer-header"><div><div className="eyebrow">任务详情</div><h2>{task ? taskTitle(task) : '正在读取任务'}</h2></div><button className="icon-button" aria-label="关闭详情" onClick={onClose}><X size={18} /></button></header>
    {loading ? <div className="loading-state"><LoaderCircle className="spin" size={22} />正在读取任务详情…</div> : !task ? <div className="alert error drawer-load-error"><AlertCircle size={17} /><div><b>任务详情加载失败</b><span>{loadError}</span></div></div> : <div className="drawer-content">{loadError && <div className="alert stale-banner" role="alert"><AlertCircle size={16} /><div><b>刷新失败，显示上次同步内容</b><span>{loadError}</span></div></div>}<div className="drawer-status-row"><span className={`status-pill ${task.status}`}>{statusLabel[task.status] || task.status}</span><span className="muted">创建于 {date(task.createdAt)}</span>{canCancel && <Button variant="danger" disabled={cancelBusy} onClick={() => void cancel()}>{cancelBusy ? '正在取消…' : '取消任务'}</Button>}</div>
      {task.status === 'waiting' && <section className="quota-wait-panel"><div className="quota-wait-icon"><Clock3 size={17} /></div><div><b>模型额度暂时受限</b><p>Zero 会保留当前进度，并在可重试时自动继续这个任务。</p><span>{retryDate(task.retryAt) ? `下一次自动重试：${retryDate(task.retryAt)}` : '下一次重试时间暂未确定；Zero 会在额度恢复后继续。'}</span>{task.error && <small>{task.error}</small>}</div></section>}
      {task.status === 'recovery_required' && <section className="quota-wait-panel recovery-required-panel"><div className="quota-wait-icon"><AlertCircle size={17} /></div><div><b>任务需要人工检查</b><p>{task.recoveryReason || '执行租约已过期。租约过期不能证明原进程已停止，因此 Zero 未自动重试。'}</p><span>请检查旧 worker 进程和任务 worktree，再决定如何继续。</span>{task.recoveryEvidence && <small>恢复证据：{JSON.stringify(task.recoveryEvidence)}</small>}</div></section>}
      {canCancel && cancelError && <div className="alert error compact"><AlertCircle size={15} />{cancelError}</div>}
      <ProjectDelivery task={task} /><BossProgress task={task} onMessage={onMessage} /><div className="detail-block"><h3><FolderGit2 size={15} />仓库与任务</h3><dl className="detail-list"><div><dt>任务 ID</dt><dd><code>{task.id}</code></dd></div><div><dt>仓库</dt><dd>{task.repoPath || '—'}</dd></div><div><dt>基础 Ref</dt><dd>{task.baseRef || '—'}</dd></div><div><dt>最大返工</dt><dd>{task.maxRevisions ?? '—'} 次</dd></div></dl><RichText className="task-description">{task.prompt || '无任务描述'}</RichText>{task.acceptanceCriteria && <><div className="sub-label">验收标准</div><RichText>{task.acceptanceCriteria}</RichText></>}</div>
      <div className="detail-block"><h3><Activity size={15} />路由决策</h3><div className="route-detail"><div><span>执行路线</span><b>{taskRouteName(task)}</b></div><div><span>选择来源</span><b>{nice(task.route?.selectionSource)}</b></div>{task.route?.reason && <p>{task.route.reason}</p>}</div></div>
      <StageTimeline task={task} /><div className="detail-block"><h3><ArrowDown size={15} />执行记录 <span className="count-badge">{attempts.length}</span></h3>{attempts.length ? <div className="attempt-list">{attempts.map((attempt, i) => <article className="attempt" key={attempt.id ?? attempt.number ?? i}><div className="attempt-head"><b>尝试 {attempt.number ?? i + 1}{attempt.role ? ` · ${roleLabel(attempt.role)}` : ""}</b><span className={`tiny-status ${attempt.status || 'pending'}`}>{stageStatusLabel(attempt.status || '')}</span><span className="muted">{date(attempt.startedAt)}</span></div>{attempt.stageId && <div className="attempt-route">阶段：{attempt.stageId}</div>}{attempt.exitCode != null && <div className="attempt-route">退出码：{attempt.exitCode}</div>}{attempt.route && <div className="attempt-route">{routeName(attempt.route)}</div>}{attempt.sessionId && <div className="attempt-route">执行会话 ID：<code style={{ userSelect: 'all', overflowWrap: 'anywhere' }}>{attempt.sessionId}</code></div>}{attempt.summary && attempt.summary !== attempt.executorSummary && <p>{attempt.summary}</p>}{attempt.executorSummary && <section className="executor-summary" aria-label="执行者自述"><b>执行者自述，需结合检查与审查确认</b><p>{attempt.executorSummary}</p></section>}{attempt.tests && <TestList tests={attempt.tests} />}{attempt.review && <Review review={attempt.review} />}{attempt.logs && <pre className="log-box">{Array.isArray(attempt.logs) ? attempt.logs.join('\n') : attempt.logs}</pre>}</article>)}</div> : <div className="soft-empty">尚无执行记录。</div>}</div>
      <CheckEvidence task={task} />
      {task.review && <div className="detail-block"><h3><ShieldCheck size={15} />Codex 审核</h3><Review review={task.review} /></div>}
      {task.error && <div className="detail-block"><h3><AlertCircle size={15} />错误信息</h3><pre className="error-box">{task.error}</pre></div>}
      {logs && <div className="detail-block"><h3><TerminalSquare size={15} />任务日志</h3><pre className="log-box large">{logs}</pre></div>}
      {task.report && <div className="detail-block"><h3><FileText size={15} />执行报告</h3><a className="report-link" href={task.report} target="_blank" rel="noreferrer"><FileText size={15} />打开归档报告<ArrowRight size={14} /></a></div>}
    </div>}</aside></div>;
}

function CheckEvidence({ task }: { task: Task }) {
  const evidence = task.checkEvidence;
  const current = evidence?.state === 'current';
  const tests = task.tests ?? [];
  const history = task.historicalTests ?? [];
  return <div className="detail-block check-evidence"><h3><CheckCircle2 size={15} />检查与验证 <span className="count-badge">{tests.length} 项{history.length ? ` · ${history.length} 项历史` : ''}</span></h3>
    <section aria-label={current ? '当前检查结果' : '检查结果（归属未确认）'}>
      {current ? <p className="evidence-note">当前检查结果仅对应下方执行批次。</p> : <p className="evidence-note"><b>{evidence?.state === 'historical' ? '当前执行尚无有效检查结果' : '检查归属尚未确认'}</b>；历史或缺少归属的结果不能确认当前改动已通过检查。</p>}
      {evidence?.runId && <dl className="detail-list check-run-identity"><div><dt>检查批次</dt><dd>{evidence.runId}</dd></div>{evidence.attemptId && <div><dt>执行尝试</dt><dd>{evidence.attemptId}</dd></div>}{evidence.stageId && <div><dt>执行阶段</dt><dd>{evidence.stageId}</dd></div>}</dl>}
      {tests.length ? <TestList tests={tests} /> : <div className="soft-empty">尚未产生可归属于当前执行的检查结果。</div>}
    </section>
    {history.length > 0 && <details className="historical-checks"><summary>历史检查记录 ({history.length})</summary><p className="evidence-note">保留用于排查返工与恢复过程；这些结果不作为当前检查结论。</p><TestList tests={history} /></details>}
  </div>;
}

function TestList({ tests }: { tests: TestResult[] }) {
  return <div className="test-list">{tests.map((test, i) => {
    const good = ['passed', 'success'].includes(test.status || '');
    const bad = ['failed', 'timed_out', 'spawn_error', 'error'].includes(test.status || '');
    const label = ({ passed: '通过', success: '通过', failed: '失败', timed_out: '超时', spawn_error: '启动失败', pending: '等待中', running: '检查中' } as Record<string, string>)[test.status || ''] || nice(test.status);
    return <div className={`check-result ${bad ? 'failed' : ''}`} key={i}><div className="test-row"><span className={`test-icon ${good ? 'good' : bad ? 'bad' : ''}`}>{good ? <CheckCircle2 size={16} /> : bad ? <XCircle size={16} /> : <Clock3 size={16} />}</span><div><b>{test.name || test.command || `检查 ${i + 1}`}</b>{test.command && test.name && <code>{test.command}</code>}</div><span className={`test-status ${good ? 'good' : bad ? 'bad' : ''}`}>{label}{test.exitCode != null ? ` · ${test.exitCode}` : ''}</span></div>{test.durationMs != null && <div className="check-duration">{Number((test.durationMs / 1000).toFixed(2))} 秒</div>}{test.output && <pre className="log-box check-output">{test.output}</pre>}</div>;
  })}</div>;
}

function StageTimeline({ task }: { task: Task }) {
  const stages = [...(task.stages ?? [])].sort((a, b) => a.sequence - b.sequence);
  const handoffs = task.handoffs ?? [];
  return <div className="detail-block"><h3><Layers3 size={16} />Agent 接力 <span className="count-badge">{stages.length} 阶段 · {handoffs.length} 交接</span></h3>
    {!stages.length && <div className="soft-empty">尚无阶段执行记录。历史任务可能未记录阶段与交接证据。</div>}
    {!!task.executionStages?.length && <details className="planned-stages"><summary>提交的执行阶段 ({task.executionStages.length})</summary>{task.executionStages.map((stage, index) => <div className="planned-stage" key={index}><b>阶段 {index + 1}</b><p>{[stage.harnessId, stage.modelId, stage.reasoningEffort].filter(Boolean).join(' / ') || '继承任务设置或自动分配'}</p>{stage.objective && <p className="stage-objective">{stage.objective}</p>}</div>)}</details>}
    <div className="stage-timeline">{stages.map((stage, index) => <article className="stage-evidence" key={stage.id}><div className="stage-number">{index + 1}</div><div className="stage-body"><div className="stage-heading"><b>阶段 {index + 1} · {roleLabel(stage.role)}</b><span className={`tiny-status ${stage.status}`}>{stageStatusLabel(stage.status)}</span></div><p className="stage-route">{[stage.harness, stage.model, stage.reasoningEffort].filter(Boolean).join(' · ') || '尚未分配执行路线'}</p><div className="stage-meta">{date(stage.startedAt || stage.createdAt)}{stage.finishedAt ? ` → ${date(stage.finishedAt)}` : ''}</div><details><summary>阶段标识与工作区指纹</summary><dl className="detail-list"><div><dt>阶段 ID</dt><dd>{stage.id}</dd></div>{stage.predecessorStageId && <div><dt>前置阶段</dt><dd>{stage.predecessorStageId}</dd></div>}<div><dt>输入指纹</dt><dd>{stage.inputFingerprint || '尚未记录'}</dd></div><div><dt>输出指纹</dt><dd>{stage.outputFingerprint || '尚未记录'}</dd></div></dl></details>{stage.error && <pre className="error-box">{stage.error}</pre>}{handoffs.filter(handoff => handoff.stageId === stage.id).map(handoff => <HandoffCard key={handoff.id} handoff={handoff} />)}</div></article>)}</div>
    {handoffs.filter(handoff => !stages.some(stage => stage.id === handoff.stageId)).map(handoff => <HandoffCard key={handoff.id} handoff={handoff} />)}
    {!handoffs.length && <p className="evidence-note">尚未产生 Agent 交接记录。</p>}
  </div>;
}

function HandoffCard({ handoff }: { handoff: NonNullable<Task['handoffs']>[number] }) {
  const groups = [{ title: '已完成', items: handoff.completed }, { title: '阻塞项', items: handoff.blockers }, { title: '风险', items: handoff.risks }, { title: '下一步', items: handoff.nextSteps }];
  return <details className="handoff-card" open><summary><ArrowRight size={14} />交接摘要 · {handoff.source.harness} / {handoff.source.model}</summary>{handoff.executorSummary && <section className="executor-summary" aria-label="执行者自述"><b>执行者自述，需结合检查与审查确认</b><p>{handoff.executorSummary}</p></section>}<p className="pre-wrap">{handoff.currentState || '未填写当前状态'}</p><div className="handoff-meta">{date(handoff.createdAt)} · 工作区 {nice(handoff.workspace.state)}</div>{groups.filter(group => group.items?.length).map(group => <div className="handoff-group" key={group.title}><b>{group.title}</b><ul>{group.items.map((item, i) => <li key={i}>{item}</li>)}</ul></div>)}{!!handoff.decisions?.length && <div className="handoff-group"><b>关键决策</b><ul>{handoff.decisions.map((item, i) => <li key={i}>{item.decision}<small>{item.rationale}</small></li>)}</ul></div>}{!!handoff.keyFiles?.length && <div className="handoff-group"><b>关键文件</b><ul>{handoff.keyFiles.map((item, i) => <li key={i}><code>{item.path}</code> · {item.reason}</li>)}</ul></div>}{!!handoff.workspace.changedFiles?.length && <div className="handoff-group"><b>变更文件</b><ul>{handoff.workspace.changedFiles.map(file => <li key={file}><code>{file}</code></li>)}</ul></div>}{!!handoff.checks?.length && <div className="handoff-group"><b>交接检查证据</b>{handoff.checks.map((check, i) => <p key={i}>{check.id} · {nice(check.status)}{check.evidence && <small>{check.evidence}</small>}</p>)}</div>}<details className="handoff-identifiers"><summary>交接与版本标识</summary><dl className="detail-list">{Object.entries({ '交接 ID': handoff.id, '来源尝试': handoff.source.attemptId, '基础提交': handoff.workspace.baseCommit, '当前提交': handoff.workspace.headCommit, '工作区指纹': handoff.workspace.fingerprint }).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || '未记录'}</dd></div>)}</dl></details></details>;
}
function Review({ review }: { review: NonNullable<Task['review']> }) {
  const pass = review.verdict === 'pass' || review.verdict === 'approved';
  return <div className="review-card"><div className="review-head"><span className={`review-verdict ${pass ? 'pass' : 'needs'}`}>{pass ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}{reviewVerdictLabel(review.verdict)}</span>{review.modelId && <span className="muted">{review.modelId}</span>}</div>{review.summary && <p>{review.summary}</p>}{review.findings?.map((f, i) => <div className="finding" key={i}><b>{f.severity || '意见'}</b>{f.file && <code>{f.file}{f.line ? `:${f.line}` : ''}</code>}<span>{f.message}</span></div>)}</div>;
}

function ExecutionPresetFields({ value, onChange, capabilities, title }: { value: ExecutionSelection; onChange: (next: ExecutionSelection) => void; capabilities: Capabilities | null; title: string }) {
  const bindings = (capabilities?.bindings ?? []).filter(b => b.available && capabilities?.harnesses.some(h => h.id === b.harnessId && h.available));
  const compatible = bindings.filter(b => !value.harnessId || b.harnessId === value.harnessId);
  const harnessChoices = [...new Map(bindings.map(b => [b.harnessId, b])).values()].map(b => ({ id: b.harnessId, label: capabilities?.harnesses.find(h => h.id === b.harnessId)?.name || b.harnessId }));
  const modelChoices = [...new Map(compatible.map(b => [b.modelId, b])).values()].map(b => ({ id: b.modelId, label: b.modelName || b.modelId }));
  const effortBindings = compatible.filter(b => !value.modelId || b.modelId === value.modelId);
  const effortChoices = [...new Map(effortBindings.flatMap(b => b.reasoningEfforts ?? []).map(choice => [choice.id, choice])).values()];
  return <div className="form-grid three execution-preset-fields" aria-label={title}>
    <Field label="Harness"><Select value={value.harnessId || ''} onChange={harnessId => onChange({ ...value, harnessId: harnessId || null, modelId: null, reasoningEffort: null })} choices={harnessChoices} placeholder="继承或自动选择" disabled={!capabilities || bindings.length === 0} /></Field>
    <Field label="模型"><Select value={value.modelId || ''} onChange={modelId => onChange({ ...value, modelId: modelId || null, reasoningEffort: null })} choices={modelChoices} placeholder="继承或自动选择" disabled={!capabilities || compatible.length === 0} /></Field>
    <Field label="思考强度" hint={!value.modelId ? '可单独锁定，系统会选择支持该强度的可用组合。' : undefined}><Select value={value.reasoningEffort || ''} onChange={reasoningEffort => onChange({ ...value, reasoningEffort: reasoningEffort || null })} choices={effortChoices} placeholder="继承或自动选择" disabled={!capabilities || effortChoices.length === 0} /></Field>
  </div>;
}

function SettingsPage({ capabilities, onSaved, onRetry }: { capabilities: Capabilities | null; onSaved: (message: string, kind: Config['allocator']['kind']) => void; onRetry: () => Promise<void> }) {
  const [config, setConfig] = useState<Config | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false);
  const [projectPath, setProjectPath] = useState('');
  useEffect(() => { let live = true; api.config().then(c => { if (live) { setConfig(normalizeConfig(c)); setError(''); } }).catch(e => { if (live) setError(e instanceof Error ? e.message : '配置读取失败'); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, []);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2200);
    return () => window.clearTimeout(timer);
  }, [saved]);
  const editConfig = (change: (current: Config) => Config) => {
    setSaved(false);
    setConfig(current => current ? change(normalizeConfig(current)) : current);
  };
  const save = async () => {
    if (!config) return;
    const emptyProject = config.executionDefaults?.projects.find(project => !normalizeSelection(project.execution));
    if (emptyProject) {
      setError(`项目“${emptyProject.repoPath}”尚未设置执行偏好；请至少选择一个字段，或移除该项目。`);
      return;
    }
    if (config.allocator.kind === 'api') {
      let secureEndpoint = false;
      const apiConfig = config.allocator.api ?? emptyApiAllocatorConfig;
      try { secureEndpoint = new URL(apiConfig.baseUrl ?? '').protocol === 'https:'; } catch { /* Invalid or missing URL. */ }
      if (!secureEndpoint || !apiConfig.model?.trim() || !apiConfig.keyEnv?.trim()) {
        setError('请填写有效的 HTTPS 地址、API 模型和密钥环境变量名。');
        return;
      }
    }
    setBusy(true); setError(''); try { const updated = normalizeConfig(await api.saveConfig(normalizeConfig(config))); setConfig(updated); setSaved(true); onSaved('路由设置已保存', updated.allocator.kind); } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  };
  const update = (role: 'allocator' | 'reviewer', key: 'modelId' | 'reasoningEffort', value: string) => editConfig(prev => ({ ...prev, [role]: { ...prev[role], [key]: value || null, ...(key === 'modelId' ? { reasoningEffort: null } : {}) } }));
  const updateApi = (key: keyof ApiAllocatorConfig, value: string) => editConfig(prev => ({ ...prev, allocator: { ...prev.allocator, api: { ...(prev.allocator.api ?? emptyApiAllocatorConfig), [key]: value || null } } }));
  const updateGlobalDefault = (execution: ExecutionSelection | null) => editConfig(prev => ({ ...prev, executionDefaults: { ...prev.executionDefaults!, global: normalizeSelection(execution) } }));
  const updateProjectDefault = (index: number, execution: ExecutionSelection) => editConfig(prev => ({ ...prev, executionDefaults: { ...prev.executionDefaults!, projects: prev.executionDefaults!.projects.map((project, i) => i === index ? { ...project, execution } : project) } }));
  const addProjectDefault = () => {
    const path = projectPath.trim();
    if (!path || !/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path)) { setError('请输入仓库的绝对路径。'); return; }
    const projects = config?.executionDefaults?.projects ?? [];
    if (projects.some(project => project.repoPath.trim().replaceAll('\\', '/').toLowerCase() === path.replaceAll('\\', '/').toLowerCase())) { setError('这个仓库路径已添加。'); return; }
    editConfig(prev => ({ ...prev, executionDefaults: { ...prev.executionDefaults!, projects: [...prev.executionDefaults!.projects, { repoPath: path, execution: {} }] } }));
    setProjectPath(''); setError('');
  };
  const removeProjectDefault = (index: number) => editConfig(prev => ({ ...prev, executionDefaults: { ...prev.executionDefaults!, projects: prev.executionDefaults!.projects.filter((_, i) => i !== index) } }));
  const options = (role: 'allocator' | 'reviewer', key: 'models' | 'reasoningEfforts') => capabilities?.[role]?.[key] ?? [];
  const effortOptions = (role: 'allocator' | 'reviewer') => {
    const modelId = config?.[role].modelId;
    if (!modelId) return options(role, 'reasoningEfforts');
    return [...new Map((capabilities?.bindings ?? []).filter(binding => binding.harnessId === 'codex' && binding.modelId === modelId && binding.available)
      .flatMap(binding => binding.reasoningEfforts ?? []).map(choice => [choice.id, choice])).values()];
  };
  const allocatorName = config?.allocator.kind === 'api' ? 'API 模型' : 'Codex';
  const apiAllocatorConfig = config?.allocator.api ?? emptyApiAllocatorConfig;
  return <><section className="page-heading"><div><h1>路由设置</h1></div></section>
    <div className="settings-layout"><div className="settings-main">
      {loading ? <div className="settings-card loading-state"><LoaderCircle className="spin" size={21} />正在读取设置…</div> : error && !config ? <div className="alert error"><AlertCircle size={17} /><div><b>设置暂不可用</b><span>{error}</span></div><Button onClick={() => { setLoading(true); api.config().then(c => { setConfig(normalizeConfig(c)); setError(''); }).catch(e => setError(e instanceof Error ? e.message : '配置读取失败')).finally(() => setLoading(false)); }}>重试</Button></div> : config && <fieldset disabled={busy} className="settings-fields" aria-label="路由设置表单">
        <section className="settings-card boss-settings"><div className="settings-card-head"><div className="role-icon codex"><Activity size={18} /></div><div><h2>Boss 与团队偏好</h2></div></div><Field label="默认 Boss 偏好" hint="自由填写，模型名称不必准确。任务中的偏好优先；最终采用的模型以任务记录为准。"><textarea aria-label="默认 Boss 偏好" rows={5} value={config.boss?.preference ?? ''} onChange={e => editConfig(prev => ({ ...prev, boss: { preference: e.target.value } }))} placeholder="例如：Boss 用 Codex gpt6.1sol high；复杂部分自己设计，必要时与其他模型讨论，具体操作优先交给便宜模型或 DeepSeek Harness。" /></Field><div className="boss-settings-current" aria-label="当前已验证模型">{(capabilities?.bindings ?? []).filter(binding => binding.available && capabilities?.harnesses.some(h => h.id === binding.harnessId && h.available)).map(binding => <span key={JSON.stringify([binding.harnessId, binding.modelId])}>{binding.harnessId} · {binding.modelName || binding.modelId}</span>)}</div>{!capabilities ? <p className="boss-settings-warning">能力尚未读取，请刷新能力状态。</p> : !(capabilities.bindings.some(binding => binding.available && capabilities.harnesses.some(h => h.id === binding.harnessId && h.available))) ? <div className="boss-settings-warning"><b>尚无可用的模型绑定</b><p>保存文字偏好不会连接或验证模型。请先在服务端配置 Harness 并验证绑定，再刷新能力状态。</p><ul>{capabilities.harnesses.filter(h => !h.available).map(h => <li key={h.id}>{h.name}：{h.reason || '未检测到可用配置'}</li>)}</ul></div> : <p className="field-hint">Boss 只会使用已验证的可用组合；无法匹配的偏好会给出原因。</p>}</section><details className="advanced-settings"><summary>高级路由配置（可选）</summary><section className="settings-card"><div className="settings-card-head"><div className="role-icon codex"><Activity size={18} /></div><div><h2>{allocatorName}分配器</h2><p>{config.allocator.kind === 'api' ? '使用兼容 OpenAI API 的模型决定任务执行路线。' : '使用 Codex 订阅和 Codex CLI 配置决定任务执行路线。'}</p></div></div>
          <Field label="分配器来源"><Select value={config.allocator.kind} onChange={kind => editConfig(prev => ({ ...prev, allocator: { ...prev.allocator, kind: kind as Config['allocator']['kind'] } }))} choices={[{ id: 'codex', label: 'Codex 订阅' }, { id: 'api', label: 'API 模型' }]} placeholder="选择分配器" /></Field>
          {config.allocator.kind === 'api' ? <>
            <div className="form-grid" style={{ marginTop: 14 }}><Field label="API HTTPS 地址" hint="必须使用 HTTPS。此处仅配置服务地址。"><input type="url" inputMode="url" pattern="https://.+" title="API 地址必须以 https:// 开头" value={apiAllocatorConfig.baseUrl ?? ''} onChange={e => updateApi('baseUrl', e.target.value)} placeholder="https://api.example.com/v1" /></Field><Field label="API 模型"><input value={apiAllocatorConfig.model ?? ''} onChange={e => updateApi('model', e.target.value)} placeholder="例如 gpt-4.1" /></Field></div>
            <div className="form-grid"><Field label="密钥环境变量名" hint="填写服务端环境变量的名称，例如 ZERO_ALLOCATOR_API_KEY；不要填写密钥值。"><input autoComplete="off" spellCheck={false} value={apiAllocatorConfig.keyEnv ?? ''} onChange={e => updateApi('keyEnv', e.target.value)} placeholder="ZERO_ALLOCATOR_API_KEY" /></Field></div>
          </> : <div className="form-grid" style={{ marginTop: 14 }}><Field label="默认模型"><Select value={config.allocator.modelId || ''} onChange={v => update('allocator', 'modelId', v)} choices={options('allocator', 'models')} placeholder="使用 Codex CLI 默认模型" /></Field><Field label="默认思考强度"><Select value={config.allocator.reasoningEffort || ''} onChange={v => update('allocator', 'reasoningEffort', v)} choices={effortOptions('allocator')} placeholder="使用 Codex CLI 默认值" /></Field></div>}
        </section>
        <section className="settings-card"><div className="settings-card-head"><div className="role-icon reviewer"><ShieldCheck size={18} /></div><div><h2>Codex Reviewer</h2><p>独立只读会话审核改动、测试证据和验收标准。</p></div><span className="fixed-badge">固定 Codex</span></div><div className="form-grid"><Field label="审核模型"><Select value={config.reviewer.modelId || ''} onChange={v => update('reviewer', 'modelId', v)} choices={options('reviewer', 'models')} placeholder="Codex 自动选择" /></Field><Field label="审核思考强度"><Select value={config.reviewer.reasoningEffort || ''} onChange={v => update('reviewer', 'reasoningEffort', v)} choices={effortOptions('reviewer')} placeholder="Codex 自动选择" /></Field></div></section>
        <section className="settings-card"><div className="settings-card-head"><div className="role-icon codex"><Settings2 size={18} /></div><div><h2>执行默认值</h2><p>为新任务设置可选的全局默认值；每个字段都可留空，由分配器自动选择。</p></div><button className="button quiet preset-clear" disabled={!config.executionDefaults?.global} onClick={() => updateGlobalDefault(null)}>清除全局预设</button></div>
          <ExecutionPresetFields title="全局执行默认值" value={config.executionDefaults?.global ?? {}} onChange={updateGlobalDefault} capabilities={capabilities} />
        </section>
        <section className="settings-card"><div className="settings-card-head"><div className="role-icon codex"><FolderGit2 size={18} /></div><div><h2>项目默认值</h2><p>按本机仓库绝对路径保存执行偏好；任务手动设置仍优先。</p></div></div>
          <div className="project-preset-add"><Field label="仓库绝对路径"><input value={projectPath} onChange={e => setProjectPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addProjectDefault(); } }} placeholder="例如 C:\\projects\\my-app" /></Field><Button onClick={addProjectDefault}><Plus size={14} />添加项目</Button></div>
          {(config.executionDefaults?.projects ?? []).length === 0 ? <div className="project-preset-empty">尚未添加项目默认值。</div> : <div className="project-preset-list">{config.executionDefaults!.projects.map((project, index) => <div className="project-preset-row" key={`${project.repoPath}-${index}`}><div className="project-preset-heading"><b title={project.repoPath}>{project.repoPath}</b><button className="button danger" onClick={() => removeProjectDefault(index)}><X size={13} />移除</button></div><ExecutionPresetFields title={`${project.repoPath} 执行默认值`} value={project.execution} onChange={execution => updateProjectDefault(index, execution)} capabilities={capabilities} /></div>)}</div>}
        </section>
        </details><div className="settings-save-row">{config.allocator.kind === 'api' && <span><ShieldCheck size={14} />界面只保存密钥环境变量名，不读取或保存 API 密钥原文。</span>}<Button variant="primary" disabled={busy || saved} onClick={() => void save()}>{busy ? <><LoaderCircle size={15} className="spin" />保存中</> : saved ? <><Check size={15} />已保存</> : '保存设置'}</Button></div>{error && <div className="alert error compact"><AlertCircle size={16} />{error}</div>}
      </fieldset>}
    </div><aside className="settings-aside"><h3>已连接的 Agent</h3><div className="settings-connections">{(capabilities?.harnesses ?? []).map(h => <div key={h.id}><span className={`health-indicator ${h.available ? 'ok' : 'off'}`} /><div><b>{h.name}</b><p>{h.available ? '可用' : h.reason || '未连接'}</p></div></div>)}</div><button className="link-button" onClick={() => void onRetry()}><RefreshCw size={15} />刷新能力状态</button></aside></div>
  </>;
}
