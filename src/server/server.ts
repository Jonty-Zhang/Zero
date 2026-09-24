import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { ConfigStore, type LocalZeroConfig } from './config-store.js';
import { TaskStore } from '../core/task-store.js';
import { CodexAdapter } from '../adapters/codex.js';
import type { AdapterConfig } from '../adapters/base.js';
import { DshAdapter } from '../adapters/dsh.js';
import { ZCodeAdapter } from '../adapters/zcode.js';
import type { ModelBinding } from '../adapters/types.js';
import type { Attempt, CheckDefinition, CheckResult, HarnessAdapter, ReviewResult, RouteDecision, TaskEvent, TaskRecord, TaskSubmission, TaskStatus } from '../domain/types.js';

type HarnessName = 'codex' | 'dsh' | 'zcode';
export type AdapterMap = Partial<Record<HarnessName, HarnessAdapter>>;
export interface TaskStorePort {
  submit(submission: TaskSubmission): TaskRecord;
  get(id: string): TaskRecord | undefined;
  list(status?: TaskStatus): TaskRecord[];
  fail(id: string, expected: TaskStatus | TaskStatus[], reason: string, owner?: string): TaskRecord;
  attempts(taskId: string): Attempt[];
  getRoute(taskId: string): RouteDecision | undefined;
  checks(taskId: string): CheckResult[];
  reviews(taskId: string): ReviewResult[];
  events(taskId: string): TaskEvent[];
}
export interface ConfigPort {
  read(): Promise<LocalZeroConfig>;
  write(config: LocalZeroConfig): Promise<void>;
}
export interface ZeroServerOptions {
  store: TaskStorePort;
  config: ConfigPort;
  adapters?: AdapterMap;
  /** Nudge the scheduler after a successful task insert. */
  enqueue?: (taskId: string) => void | Promise<void>;
  /** Must ask the active Worker to stop the complete task process tree. */
  cancel?: (taskId: string) => boolean | Promise<boolean>;
  staticDir?: string;
  artifactRoot?: string;
  /** Exact Host values forwarded by a trusted local dev proxy, e.g. localhost:5173. */
  trustedProxyHosts?: string[];
  maxBodyBytes?: number;
}

const REASONING = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const KNOWN_HARNESSES: HarnessName[] = ['codex', 'dsh', 'zcode'];
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" };
const JSON_HEADERS = { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export function createDefaultAdapters(bindings: ModelBinding[]): AdapterMap {
  return {
    codex: createCodexAdapter(bindings),
    dsh: new DshAdapter({ bindings, dshHome: resolve(zeroDataRoot(), 'dsh-home') }),
    zcode: new ZCodeAdapter({ bindings }),
  };
}

function zeroDataRoot(): string {
  return resolve(process.env.ZERO_DATA_DIR || (process.platform === 'win32'
    ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData/Local'), 'Zero')
    : resolve(homedir(), '.local/share/zero')));
}

/** Use the explicitly configured Codex CLI path for both runtime and binding verification. */
export function createCodexAdapter(bindings: ModelBinding[], config: Omit<AdapterConfig, 'bindings' | 'executable'> = {}): CodexAdapter {
  const executable = process.env.ZERO_CODEX_EXE?.trim();
  return new CodexAdapter({ ...config, bindings, ...(executable ? { executable } : {}) });
}

export function createZeroServer(options: ZeroServerOptions): Server {
  const server = createServer((req, res) => { void handleRequest(req, res, options); });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, options: ZeroServerOptions): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    validateLocalHost(req, options.trustedProxyHosts ?? []);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') && url.pathname.startsWith('/api/')) validateMutationOrigin(req);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && url.pathname === '/api/capabilities') return json(res, 200, await capabilities(options));
      if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, await readPublicConfig(options));
      if (url.pathname === '/api/config' && req.method === 'PUT') return json(res, 200, await updatePublicConfig(options, await bodyJson(req, options.maxBodyBytes)));
      if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, options.store.list().map(mapTaskList));
      if (url.pathname === '/api/tasks' && req.method === 'POST') {
        const submission = await parseSubmission(await bodyJson(req, options.maxBodyBytes), options);
        const task = options.store.submit(submission);
        if (options.enqueue) void Promise.resolve(options.enqueue(task.id)).catch((error: unknown) => {
          try { options.store.fail(task.id, 'pending', `Scheduler enqueue failed: ${message(error)}`); } catch { /* A worker may have claimed it already. */ }
        });
        return json(res, 201, mapTaskList(task));
      }
      const taskPath = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(cancel|report))?$/);
      if (taskPath) {
        const id = decodeURIComponent(taskPath[1]!);
        if (taskPath[2] === 'cancel' && req.method === 'POST') return await cancelTask(res, id, options);
        if (taskPath[2] === 'report' && req.method === 'GET') return await taskReport(res, id, options);
        if (!taskPath[2] && req.method === 'GET') return await taskDetail(res, id, options);
      }
      return json(res, 404, { error: 'API route not found' });
    }
    await staticFile(res, url.pathname, options.staticDir);
  } catch (error) {
    const code = error instanceof HttpError ? error.status : 500;
    json(res, code, { error: message(error) });
  }
}

async function capabilities(options: ZeroServerOptions) {
  const config = await options.config.read();
  const adapters = options.adapters ?? createDefaultAdapters(config.bindings);
  const reports = new Map<HarnessName, Awaited<ReturnType<HarnessAdapter['probe']>>>();
  await Promise.all(KNOWN_HARNESSES.map(async id => {
    const adapter = adapters[id];
    if (!adapter) return;
    try { reports.set(id, await adapter.probe()); }
    catch (error) { reports.set(id, { harness: id, available: false, unavailableReason: message(error), models: [], reasoningEfforts: [] }); }
  }));
  const bindings = config.bindings.map(binding => {
    const result = reports.get(binding.harness);
    const selectorResult = !!result?.available && result.models.includes(binding.model.id);
    const verification = config.verifications?.[`${binding.harness}:${binding.model.id}`];
    const available = binding.verified && !!verification && selectorResult;
    const reason = !binding.verified || !verification ? '该模型绑定尚未通过验证（尚未通过真实调用验证）' : !result?.available ? result?.unavailableReason ?? 'Harness 不可用' : !selectorResult ? '当前 CLI 探测未确认此模型绑定' : undefined;
    const verificationLevel = verification?.level;
    return { harnessId: binding.harness, modelId: binding.model.id, modelName: binding.model.modelId, available, ...(reason ? { reason } : {}), ...(verificationLevel ? { verificationLevel } : {}),
      reasoningEfforts: available ? (binding.reasoningEfforts ?? result?.reasoningEfforts ?? []).map(id => ({ id, label: id })) : [] };
  });
  const harnesses = KNOWN_HARNESSES.map(id => {
    const result = reports.get(id);
    const cliAvailable = !!result?.available;
    const hasVerifiedModel = bindings.some(binding => binding.harnessId === id && binding.available);
    const available = cliAvailable && hasVerifiedModel;
    const reason = !cliAvailable ? result?.unavailableReason ?? 'Adapter 未配置'
      : !hasVerifiedModel ? 'CLI 可运行，但没有完成真实调用验证的模型绑定' : undefined;
    return { id, name: ({ codex: 'Codex', dsh: 'DSH', zcode: 'ZCode' } as const)[id], available, cliAvailable,
      ...(result?.version ? { version: result.version } : {}), ...(reason ? { reason } : {}) };
  });
  const codexChoices = bindings.filter(b => b.harnessId === 'codex' && b.available).map(b => ({ id: b.modelId, label: b.modelName }));
  const codexEfforts = [...new Set(bindings.filter(b => b.harnessId === 'codex' && b.available).flatMap(b => b.reasoningEfforts.map(e => e.id)))].map(id => ({ id, label: id }));
  return { harnesses, bindings, allocator: { models: codexChoices, reasoningEfforts: codexEfforts }, reviewer: { models: codexChoices, reasoningEfforts: codexEfforts } };
}

async function readPublicConfig(options: ZeroServerOptions) {
  const config = await options.config.read();
  const active = await capabilities(options);
  const modelIds = new Set(active.allocator.models.map((choice: { id: string }) => choice.id));
  const efforts = new Set(active.allocator.reasoningEfforts.map((choice: { id: string }) => choice.id));
  return {
    allocator: { modelId: config.allocator.modelId && modelIds.has(config.allocator.modelId) ? config.allocator.modelId : null,
      reasoningEffort: config.allocator.reasoningEffort && efforts.has(config.allocator.reasoningEffort) ? config.allocator.reasoningEffort : null },
    reviewer: { modelId: config.reviewer.modelId && modelIds.has(config.reviewer.modelId) ? config.reviewer.modelId : null,
      reasoningEffort: config.reviewer.reasoningEffort && efforts.has(config.reviewer.reasoningEffort) ? config.reviewer.reasoningEffort : null },
  };
}

async function updatePublicConfig(options: ZeroServerOptions, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, '配置必须是 JSON 对象');
  const input = raw as Record<string, unknown>;
  const active = await capabilities(options);
  const models = new Set(active.allocator.models.map((choice: { id: string }) => choice.id));
  const efforts = new Set(active.allocator.reasoningEfforts.map((choice: { id: string }) => choice.id));
  const pick = (role: 'allocator' | 'reviewer') => {
    const value = input[role];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${role} 必须是对象`);
    const v = value as Record<string, unknown>;
    const modelId = nullableString(v.modelId, `${role}.modelId`);
    const reasoningEffort = nullableString(v.reasoningEffort, `${role}.reasoningEffort`);
    if (modelId && !models.has(modelId)) throw new HttpError(400, `${role} 模型不是当前已验证的 Codex 候选`);
    if (reasoningEffort && !efforts.has(reasoningEffort)) throw new HttpError(400, `${role} 思考强度不是当前已验证的 Codex 候选`);
    if (modelId && reasoningEffort && !active.bindings.some((binding: { harnessId: string; modelId: string; available: boolean; reasoningEfforts: Array<{ id: string }> }) => binding.harnessId === 'codex' && binding.modelId === modelId && binding.available && binding.reasoningEfforts.some(item => item.id === reasoningEffort))) throw new HttpError(400, `${role} 思考强度未在所选 Codex 模型上验证`);
    return { modelId, reasoningEffort: reasoningEffort as LocalZeroConfig['allocator']['reasoningEffort'] };
  };
  const config = await options.config.read();
  config.allocator = pick('allocator'); config.reviewer = pick('reviewer');
  await options.config.write(config);
  return { allocator: config.allocator, reviewer: config.reviewer };
}

async function parseSubmission(raw: unknown, options: ZeroServerOptions): Promise<TaskSubmission> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, '任务内容必须是 JSON 对象');
  const input = raw as Record<string, unknown>;
  const repoInput = stringField(input.repoPath, 'repoPath', 1, 4096);
  if (!isAbsolute(repoInput)) throw new HttpError(400, 'repoPath 必须是绝对路径');
  let repoPath: string;
  try { repoPath = await realpath(repoInput); } catch { throw new HttpError(400, 'repoPath 不存在或无法访问'); }
  if (!(await stat(repoPath)).isDirectory()) throw new HttpError(400, 'repoPath 必须是目录');
  const git = spawnSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (git.error || git.status !== 0) throw new HttpError(400, 'repoPath 必须是可访问的 Git 工作区');
  const root = await realpath(git.stdout.trim());
  if (root !== repoPath) repoPath = root;
  const baseRef = typeof input.baseRef === 'string' && input.baseRef.trim() ? input.baseRef.trim() : 'HEAD';
  if (baseRef.length > 255 || baseRef.startsWith('-') || /[\0\r\n]/.test(baseRef)) throw new HttpError(400, 'baseRef 格式无效');
  const baseCheck = spawnSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (baseCheck.error || baseCheck.status !== 0) throw new HttpError(400, 'baseRef 必须指向该仓库中存在的提交或分支');
  const prompt = stringField(input.prompt, 'prompt', 8, 100_000);
  const criteria = input.acceptanceCriteria == null ? [] : typeof input.acceptanceCriteria === 'string'
    ? input.acceptanceCriteria.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    : Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.every(v => typeof v === 'string') ? input.acceptanceCriteria as string[] : (() => { throw new HttpError(400, 'acceptanceCriteria 必须是文本'); })();
  if (criteria.some(s => s.length > 4000) || criteria.length > 100) throw new HttpError(400, '验收标准过长');
  const maxRevisions = input.maxRevisions == null ? 2 : Number(input.maxRevisions);
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 10) throw new HttpError(400, 'maxRevisions 必须在 0 到 10 之间');
  const checks = parseChecks(input.checkCommands);
  const rawSelection = input.execution;
  const selection = rawSelection == null ? undefined : validateSelection(rawSelection, await capabilities(options));
  return { repoPath, baseRef, prompt, acceptanceCriteria: criteria, maxRevisions, checks, ...(selection ? { selection } : {}) };
}

function validateSelection(raw: unknown, capability: Awaited<ReturnType<typeof capabilities>>): NonNullable<TaskSubmission['selection']> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'execution 必须是对象');
  const input = raw as Record<string, unknown>;
  const harness = nullableString(input.harnessId, 'execution.harnessId');
  const model = nullableString(input.modelId, 'execution.modelId');
  const reasoningEffort = nullableString(input.reasoningEffort, 'execution.reasoningEffort');
  if (!harness && !model && !reasoningEffort) return undefined;
  const candidates = capability.bindings.filter(binding => binding.available && (!harness || binding.harnessId === harness) && (!model || binding.modelId === model));
  if (!candidates.length) throw new HttpError(400, '所选 Harness 与模型没有通过探测的可用组合');
  if (reasoningEffort && !candidates.some(binding => binding.reasoningEfforts.some((item: { id: string }) => item.id === reasoningEffort))) throw new HttpError(400, '该 Harness 与模型组合不支持所选思考强度');
  return { ...(harness ? { harness } : {}), ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function parseChecks(value: unknown): CheckDefinition[] {
  if (value == null || value === '') return [];
  if (!Array.isArray(value) || value.length > 50 || !value.every(v => typeof v === 'string')) throw new HttpError(400, 'checkCommands 必须是命令字符串数组');
  return value.map((line, index) => {
    if (line.length > 2000 || /[\0\r\n]/.test(line) || /[;&|<>`$]/.test(line)) throw new HttpError(400, `第 ${index + 1} 条检查命令包含不支持的 shell 控制字符`);
    const argv = tokenize(line);
    if (!argv.length) throw new HttpError(400, `第 ${index + 1} 条检查命令为空`);
    if (argv.some(arg => arg.startsWith('@(') || arg.startsWith('$(') || arg.startsWith('-') && arg === '--')) throw new HttpError(400, `第 ${index + 1} 条检查命令参数无效`);
    return { id: `check-${index + 1}`, argv };
  });
}

function tokenize(line: string): string[] {
  const result: string[] = []; let token = ''; let quote: "'" | '"' | undefined; let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) token += line[++i]!;
      else token += c;
      started = true;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { result.push(token); token = ''; started = false; } }
    else token += c, started = true;
  }
  if (quote) throw new HttpError(400, '检查命令存在未闭合引号');
  if (started) result.push(token);
  return result;
}

async function cancelTask(res: ServerResponse, id: string, options: ZeroServerOptions): Promise<void> {
  const task = options.store.get(id);
  if (!task) throw new HttpError(404, '任务不存在');
  if (task.status === 'pending' || task.status === 'waiting') {
    options.store.fail(id, task.status, 'Cancelled by user');
    return json(res, 200, { ok: true });
  }
  if (!['running', 'reviewing', 'revision'].includes(task.status)) throw new HttpError(409, '任务已结束，无法取消');
  const stopped = options.cancel ? await options.cancel(id) : await cancelThroughAdapter(id, task, options);
  if (!stopped) throw new HttpError(503, 'Worker 未确认取消请求；任务状态保持不变');
  json(res, 202, { ok: true, status: task.status });
}

async function cancelThroughAdapter(id: string, task: TaskRecord, options: ZeroServerOptions): Promise<boolean> {
  const attempt = options.store.attempts(id).find(item => item.status === 'running');
  if (!attempt || typeof attempt.id !== 'string' || typeof attempt.harness !== 'string') return false;
  const adapter = options.adapters?.[attempt.harness as HarnessName];
  if (!adapter?.cancel) return false;
  await adapter.cancel(id, attempt.id);
  return true;
}

async function taskDetail(res: ServerResponse, id: string, options: ZeroServerOptions): Promise<void> {
  const task = options.store.get(id);
  if (!task) throw new HttpError(404, '任务不存在');
  const attempts = options.store.attempts(id);
  const checks = options.store.checks(id);
  const reviews = options.store.reviews(id);
  const events = options.store.events(id);
  const route = options.store.getRoute(id);
  const attemptDetails = await Promise.all(attempts.map(async attempt => {
    const stdout = await readArtifactText(attempt.stdoutPath, options.artifactRoot);
    const stderr = await readArtifactText(attempt.stderrPath, options.artifactRoot);
    const text = [stdout ? `--- stdout ---\n${stdout}` : '', stderr ? `--- stderr ---\n${stderr}` : ''].filter(Boolean).join('\n');
    return { ...mapAttempt(attempt), ...(text ? { logs: text } : {}) };
  }));
  const logs = attemptDetails.map((attempt, index) => attempt.logs ? `Attempt ${index + 1}\n${attempt.logs}` : '').filter(Boolean).join('\n\n');
  const reportPath = options.artifactRoot && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? join(resolve(options.artifactRoot), id, 'report.json') : undefined;
  const report = reportPath && (await access(reportPath).then(() => true).catch(() => false)) ? `/api/tasks/${encodeURIComponent(id)}/report` : undefined;
  json(res, 200, { ...mapTaskList(task), prompt: task.prompt, acceptanceCriteria: task.acceptanceCriteria?.join('\n'), baseRef: task.baseRef,
    maxRevisions: task.maxRevisions, route: route ? mapRoute(route) : undefined,
    attempts: attemptDetails, tests: checks.map(mapCheck), review: reviews.length ? mapReview(reviews.at(-1)!) : undefined,
    logs, report, error: task.failureReason, events: events.map(event => ({ type: event.type, at: event.at, payload: event.payload })) });
}

function mapTaskList(task: TaskRecord) {
  const route = task.route;
  return { id: task.id, title: task.prompt.split(/\r?\n/, 1)[0]?.slice(0, 100), status: task.status,
    repoPath: task.repoPath, baseRef: task.baseRef, createdAt: task.createdAt, updatedAt: task.updatedAt,
    maxRevisions: task.maxRevisions, route: route ? mapRoute(route as unknown as Record<string, unknown>) : undefined,
    retryAt: task.status === 'waiting' ? task.retryAt : undefined, error: task.failureReason };
}
function mapRoute(route: Record<string, unknown> | RouteDecision) { const value = route as Record<string, unknown>; return { harnessId: value.harness, modelId: value.model, reasoningEffort: value.effectiveReasoningEffort ?? value.reasoningEffort, selectionSource: value.selectionSource, reason: value.reason }; }
function mapAttempt(value: Attempt) {
  const metadata = value.metadata ?? {};
  return { number: value.sequence, status: value.status, startedAt: value.startedAt, endedAt: value.finishedAt,
    route: value.harness || value.model ? { harnessId: value.harness, modelId: value.model, reasoningEffort: value.reasoningEffort } : undefined,
    sessionId: typeof metadata.sessionId === 'string' ? metadata.sessionId : undefined,
    summary: value.error ?? metadata.summary };
}
function mapCheck(value: CheckResult) { return { name: value.id, command: value.argv.join(' '), status: value.status, exitCode: value.exitCode, durationMs: value.durationMs, output: value.error }; }
function mapReview(value: ReviewResult) {
  return { verdict: value.verdict, summary: value.summary, findings: value.findings.map(f => ({ severity: f.severity, file: f.file, line: f.line, message: `${f.evidence} ${f.requestedChange}` })) };
}

async function taskReport(res: ServerResponse, id: string, options: ZeroServerOptions): Promise<void> {
  const task = options.store.get(id);
  if (!task) throw new HttpError(404, '任务不存在');
  if (!options.artifactRoot || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new HttpError(404, '执行报告不存在');
  const root = await realpath(options.artifactRoot).catch(() => undefined);
  if (!root) throw new HttpError(404, '执行报告不存在');
  const directory = await realpath(join(root, id)).catch(() => undefined);
  if (!directory || resolve(directory, '..') !== root) throw new HttpError(404, '执行报告不存在');
  const reportPath = resolve(directory, 'report.json');
  const canonicalReport = await realpath(reportPath).catch(() => undefined);
  if (!canonicalReport || !canonicalReport.startsWith(directory + sep)) throw new HttpError(404, '执行报告不存在');
  const report = JSON.parse(await readFile(canonicalReport, 'utf8')) as Record<string, unknown>;
  // SQLite is authoritative if a process crashed between report rename and the final DB transition.
  if (report.task && typeof report.task === 'object') report.task = { ...(report.task as Record<string, unknown>), status: task.status };
  report.finalStatus = task.status;
  const bytes = Buffer.from(JSON.stringify(report, null, 2));
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="zero-${id}.json"`, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
  res.end(bytes);
}

async function readArtifactText(path: string | undefined, artifactRoot: string | undefined): Promise<string | undefined> {
  if (!path || !artifactRoot) return undefined;
  const root = await realpath(artifactRoot).catch(() => undefined);
  if (!root) return undefined;
  const target = await realpath(path).catch(() => undefined);
  if (!target || !target.startsWith(root + sep)) return undefined;
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size > 256 * 1024) return '[日志超过单次详情读取上限]';
    return await readFile(target, 'utf8');
  } catch { return undefined; }
}

async function staticFile(res: ServerResponse, pathname: string, staticDir = resolve('web/dist')): Promise<void> {
  const safePath = decodeURIComponent(pathname);
  const file = safePath === '/' ? 'index.html' : safePath.replace(/^\/+/, '');
  const root = await realpath(staticDir).catch(() => undefined);
  if (!root) throw new HttpError(404, 'Web build 不存在；请在 web 目录执行 npm run build');
  let target = resolve(root, file);
  if (target !== root && !target.startsWith(root + sep)) target = join(root, 'index.html');
  let bytes: Buffer;
  try { bytes = await readFile(target); } catch { bytes = await readFile(join(root, 'index.html')); target = join(root, 'index.html'); }
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': contentType(extname(target)), 'Content-Length': bytes.length, 'Cache-Control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
  res.end(bytes);
}
function contentType(ext: string) { return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' } as Record<string,string>)[ext] ?? 'application/octet-stream'; }

async function bodyJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); length += chunk.length;
    if (length > maxBytes) throw new HttpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, '请求体必须是有效 JSON'); }
}
function stringField(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new HttpError(400, `${name} 长度必须在 ${min} 到 ${max} 个字符之间`);
  return value.trim();
}
function nullableString(value: unknown, name: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || /[\0\r\n]/.test(value)) throw new HttpError(400, `${name} 格式无效`);
  return value;
}
function json(res: ServerResponse, status: number, value: unknown): void { const body = Buffer.from(JSON.stringify(value)); res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': body.length }); res.end(body); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function validateMutationOrigin(req: IncomingMessage): void {
  const hostHeader = req.headers.host;
  if (!hostHeader) throw new HttpError(403, '缺少 Host 请求头');
  let host: URL;
  try { host = new URL(`http://${hostHeader}`); } catch { throw new HttpError(403, 'Host 请求头无效'); }
  const local = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if (!local(host.hostname)) throw new HttpError(403, 'Zero API 仅接受 loopback 请求');
  const origin = req.headers.origin;
  if (origin) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new HttpError(403, 'Origin 请求头无效'); }
    if (parsed.protocol !== 'http:' || !local(parsed.hostname) || parsed.host.toLowerCase() !== host.host.toLowerCase()) throw new HttpError(403, '跨站修改请求已拒绝');
  }
}
function validateLocalHost(req: IncomingMessage, trustedProxyHosts: string[]): void {
  const hostHeader = req.headers.host;
  if (!hostHeader) throw new HttpError(403, '缺少 Host 请求头');
  let host: URL;
  try { host = new URL(`http://${hostHeader}`); } catch { throw new HttpError(403, 'Host 请求头无效'); }
  const isLoopback = host.hostname === 'localhost' || host.hostname === '127.0.0.1' || host.hostname === '[::1]';
  const hostPort = Number(host.port || 80);
  const boundPort = req.socket.localPort;
  const proxied = trustedProxyHosts.some(item => item.toLowerCase() === host.host.toLowerCase());
  if (!isLoopback || (hostPort !== boundPort && !proxied)) throw new HttpError(403, 'Host 必须是 Zero loopback 监听地址');
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export { TaskStore, ConfigStore };
