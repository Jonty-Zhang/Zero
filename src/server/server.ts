import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { ConfigStore, type LocalZeroConfig } from './config-store.js';
import { TaskStore, GoalReviewRetryConflictError, type SequenceGoalReviewRetryRequest, type CheckRunRecord, type CheckRunIntegrityFailureRecord } from '../core/task-store.js';
import { selectTaskCheckEvidence } from './task-check-evidence.js';
import { CodexAdapter } from '../adapters/codex.js';
import { IdempotencyConflictError, submissionRequestHash, validateSubmissionKey } from '../core/submission-idempotency.js';
import type { AdapterConfig } from '../adapters/base.js';
import { DshAdapter } from '../adapters/dsh.js';
import { ZCodeCompositeAdapter } from '../adapters/zcode-composite.js';
import type { ModelBinding } from '../adapters/types.js';
import type { Attempt, CheckDefinition, CheckResult, ExecutionSelection, HandoffRecord, HarnessAdapter, ReviewResult, RouteDecision, SequenceGoalReview, StageRecord, TaskEvent, TaskRecord, TaskSequenceMetadata, TaskSequenceRecord, TaskSubmission, TaskStatus } from '../domain/types.js';

type HarnessName = 'codex' | 'dsh' | 'zcode';
export type AdapterMap = Partial<Record<HarnessName, HarnessAdapter>>;
export interface TaskStorePort {
  submit(submission: TaskSubmission): TaskRecord;
  createSequence(submissions: TaskSubmission[], id?: string, metadata?: TaskSequenceMetadata): TaskSequenceRecord;
  lookupSubmissionRequest?(key: string, kind: 'task' | 'sequence', requestHash: string): { resourceId: string } | undefined;
  submitIdempotent?(submission: TaskSubmission, request: { key: string; requestHash: string }): { record: TaskRecord; replayed: boolean };
  createSequenceIdempotent?(submissions: TaskSubmission[], metadata: TaskSequenceMetadata, request: { key: string; requestHash: string }): { record: TaskSequenceRecord; replayed: boolean };
  getSequence(id: string): (TaskSequenceRecord & { goalReview?: SequenceGoalReview }) | undefined;
  listSequences(): Array<TaskSequenceRecord & { goalReview?: SequenceGoalReview }>;
  requestSequenceGoalReviewRetry?(sequenceId: string, expectedAttemptId: string): SequenceGoalReviewRetryRequest;
  get(id: string): TaskRecord | undefined;
  list(status?: TaskStatus): TaskRecord[];
  fail(id: string, expected: TaskStatus | TaskStatus[], reason: string, owner?: string): TaskRecord;
  attempts(taskId: string): Attempt[];
  stages?(taskId: string): StageRecord[];
  handoffs?(taskId: string): HandoffRecord[];
  getRoute(taskId: string): RouteDecision | undefined;
  checks(taskId: string): CheckResult[];
  checkRuns?(taskId: string): CheckRunRecord[];
  checkRunResults?(runId: string): CheckResult[];
  checkRunIntegrityFailure?(runId: string): CheckRunIntegrityFailureRecord | undefined;
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
  /** Nudge aggregate review after its explicit retry request has been persisted. */
  enqueueGoalReview?: (sequenceId: string) => void | Promise<void>;
  /** Must ask the active Worker to stop the complete task process tree. */
  cancel?: (taskId: string) => boolean | Promise<boolean>;
  staticDir?: string;
  artifactRoot?: string;
  /** Exact Host values forwarded by a trusted local dev proxy, e.g. localhost:5173. */
  trustedProxyHosts?: string[];
  maxBodyBytes?: number;
}

const REASONING = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const MAX_SEQUENCE_STEPS = 20;
const KNOWN_HARNESSES: HarnessName[] = ['codex', 'dsh', 'zcode'];
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" };
const JSON_HEADERS = { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export function createDefaultAdapters(bindings: ModelBinding[]): AdapterMap {
  return {
    codex: createCodexAdapter(bindings),
    dsh: new DshAdapter({ bindings, dshHome: resolve(zeroDataRoot(), 'dsh-home') }),
    zcode: new ZCodeCompositeAdapter({ bindings }),
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
  const windowsSandbox = process.env.ZERO_CODEX_WINDOWS_SANDBOX;
  if (windowsSandbox !== undefined && windowsSandbox !== 'elevated' && windowsSandbox !== 'unelevated') {
    throw new Error('ZERO_CODEX_WINDOWS_SANDBOX must be elevated or unelevated');
  }
  return new CodexAdapter({
    ...config,
    bindings,
    ...(executable ? { executable } : {}),
    ...(windowsSandbox !== undefined ? { codexWindowsSandbox: windowsSandbox } : {}),
  });
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
      if (url.pathname === '/api/sequences' && req.method === 'GET') return json(res, 200, options.store.listSequences().map(mapSequence));
      if (url.pathname === '/api/sequences' && req.method === 'POST') {
        const raw = await bodyJson(req, options.maxBodyBytes);
        const identity = submissionIdentity(req, raw, 'sequence', options.store);
        const previous = identity && options.store.lookupSubmissionRequest!(identity.key, 'sequence', identity.requestHash);
        if (previous) {
          const sequence = options.store.getSequence(previous.resourceId);
          if (!sequence) throw new HttpError(500, 'Persisted idempotency request refers to a missing sequence');
          return json(res, 201, mapSequence(sequence));
        }
        const { submissions, metadata } = await parseSequence(raw, options);
        const { record: sequence, replayed } = identity
          ? options.store.createSequenceIdempotent!(submissions, metadata, identity)
          : { record: options.store.createSequence(submissions, undefined, metadata), replayed: false };
        if (options.enqueue && !replayed) {
          for (const step of sequence.steps) void Promise.resolve().then(() => options.enqueue!(step.task.id)).catch((error: unknown) => {
            try { options.store.fail(step.task.id, 'pending', `Scheduler enqueue failed: ${message(error)}`); } catch { /* A worker may have claimed it already. */ }
          });
        }
        return json(res, 201, mapSequence(sequence));
      }
      const sequencePath = url.pathname.match(/^\/api\/sequences\/([^/]+)$/);
      if (sequencePath && req.method === 'GET') {
        const id = decodeURIComponent(sequencePath[1]!);
        const sequence = options.store.getSequence(id);
        if (!sequence) throw new HttpError(404, '任务序列不存在');
        return json(res, 200, mapSequence(sequence));
      }
      const retryGoalPath = url.pathname.match(/^\/api\/sequences\/([^/]+)\/goal-review\/retry$/);
      if (retryGoalPath && req.method === 'POST') {
        const id = decodeURIComponent(retryGoalPath[1]!);
        if (!options.store.getSequence(id)) throw new HttpError(404, '任务序列不存在');
        const raw = await bodyJson(req, options.maxBodyBytes);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, '重新验收请求必须是对象');
        const input = raw as Record<string, unknown>;
        if (Object.keys(input).some(key => key !== 'attemptId')) throw new HttpError(400, '重新验收请求包含不支持的字段');
        const attemptId = stringField(input.attemptId, 'attemptId', 1, 256);
        if (!options.store.requestSequenceGoalReviewRetry) throw new HttpError(501, '此任务存储不支持持久重新验收请求');
        options.store.requestSequenceGoalReviewRetry(id, attemptId);
        const queued = options.store.getSequence(id)!;
        if (options.enqueueGoalReview) void Promise.resolve().then(() => options.enqueueGoalReview!(id)).catch(() => {
          console.warn('[zero] Goal review retry is persisted; scheduler nudge could not complete.');
        });
        return json(res, 202, mapSequence(queued));
      }
      if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, options.store.list().map(mapTaskList));
      if (url.pathname === '/api/tasks' && req.method === 'POST') {
        const raw = await bodyJson(req, options.maxBodyBytes);
        const identity = submissionIdentity(req, raw, 'task', options.store);
        const previous = identity && options.store.lookupSubmissionRequest!(identity.key, 'task', identity.requestHash);
        if (previous) {
          const task = options.store.get(previous.resourceId);
          if (!task) throw new HttpError(500, 'Persisted idempotency request refers to a missing task');
          return json(res, 201, mapTaskList(task));
        }
        const submission = await parseSubmission(raw, options);
        const { record: task, replayed } = identity
          ? options.store.submitIdempotent!(submission, identity)
          : { record: options.store.submit(submission), replayed: false };
        if (options.enqueue && !replayed) void Promise.resolve(options.enqueue(task.id)).catch((error: unknown) => {
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
    const code = error instanceof HttpError ? error.status : error instanceof IdempotencyConflictError || error instanceof GoalReviewRetryConflictError ? 409 : 500;
    json(res, code, { error: message(error) });
  }
}

function submissionIdentity(req: IncomingMessage, raw: unknown, kind: 'task' | 'sequence', store: TaskStorePort): { key: string; requestHash: string } | undefined {
  const header = req.headers['x-idempotency-key'];
  if (header === undefined) return undefined;
  let key: string;
  try { key = validateSubmissionKey(header); }
  catch (error) { throw new HttpError(400, message(error)); }
  if (!store.lookupSubmissionRequest || !(kind === 'task' ? store.submitIdempotent : store.createSequenceIdempotent)) {
    throw new HttpError(501, 'Durable submission idempotency is not supported by this task store');
  }
  try { return { key, requestHash: submissionRequestHash(raw) }; }
  catch (error) { throw new HttpError(400, message(error)); }
}

async function parseSequence(raw: unknown, options: ZeroServerOptions): Promise<{ submissions: TaskSubmission[]; metadata: TaskSequenceMetadata }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, '任务序列内容必须是 JSON 对象');
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.tasks) || input.tasks.length < 2 || input.tasks.length > MAX_SEQUENCE_STEPS) {
    throw new HttpError(400, `tasks 必须包含 2 到 ${MAX_SEQUENCE_STEPS} 个任务`);
  }
  const metadata: TaskSequenceMetadata = {};
  if (input.maxGoalRevisions !== undefined) {
    if (!Number.isInteger(input.maxGoalRevisions) || (input.maxGoalRevisions as number) < 0 || (input.maxGoalRevisions as number) > 5) {
      throw new HttpError(400, 'maxGoalRevisions 必须是 0 到 5 之间的整数');
    }
    metadata.maxGoalRevisions = input.maxGoalRevisions as number;
  }
  if (input.objective !== undefined && input.objective !== null && input.objective !== '') {
    metadata.objective = stringField(input.objective, 'objective', 1, 10_000);
  }
  if (input.acceptanceCriteria !== undefined && input.acceptanceCriteria !== null) {
    const criteria = typeof input.acceptanceCriteria === 'string'
      ? input.acceptanceCriteria.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
      : Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.every(item => typeof item === 'string')
        ? (input.acceptanceCriteria as string[]).map(item => item.trim()).filter(Boolean)
        : undefined;
    if (!criteria || !criteria.length || criteria.length > 100 || criteria.some(item => item.length > 4000)) {
      throw new HttpError(400, 'acceptanceCriteria 必须包含 1 到 100 条有效文本，每条不超过 4000 个字符');
    }
    metadata.acceptanceCriteria = criteria;
  }
  // Validate every submission first. createSequence is called only after the entire
  // batch has passed the same checks as an individual task submission.
  const capability = await capabilities(options);
  const submissions: TaskSubmission[] = [];
  for (const task of input.tasks) submissions.push(await parseSubmission(task, options, capability));
  return { submissions, metadata };
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
  return {
    allocator: { kind: config.allocator.kind ?? 'codex',
      modelId: config.allocator.modelId,
      reasoningEffort: config.allocator.reasoningEffort,
      ...(config.allocator.api ? { api: { ...config.allocator.api } } : {}) },
    reviewer: { modelId: config.reviewer.modelId,
      reasoningEffort: config.reviewer.reasoningEffort },
    executionDefaults: {
      global: publicExecutionSelection(config.executionDefaults?.global ?? null),
      projects: Object.entries(config.executionDefaults?.projects ?? {}).map(([repoPath, execution]) => ({ repoPath, execution: publicExecutionSelection(execution)! })),
    },
  };
}

async function updatePublicConfig(options: ZeroServerOptions, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, '配置必须是 JSON 对象');
  const input = raw as Record<string, unknown>;
  const active = await capabilities(options);
  const models = new Set(active.allocator.models.map((choice: { id: string }) => choice.id));
  const efforts = new Set(active.allocator.reasoningEfforts.map((choice: { id: string }) => choice.id));
  const config = await options.config.read();
  const pick = (role: 'allocator' | 'reviewer') => {
    const value = input[role];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${role} 必须是对象`);
    const v = value as Record<string, unknown>;
    const modelId = nullableString(v.modelId, `${role}.modelId`);
    const reasoningEffort = nullableString(v.reasoningEffort, `${role}.reasoningEffort`);
    // Availability is transient; saving other settings must not erase an existing
    // choice. Only the exact saved pair may bypass current-candidate validation.
    if (modelId === config[role].modelId && reasoningEffort === config[role].reasoningEffort) {
      return { modelId, reasoningEffort: reasoningEffort as LocalZeroConfig['allocator']['reasoningEffort'] };
    }
    if (modelId && !models.has(modelId)) throw new HttpError(400, `${role} 模型不是当前已验证的 Codex 候选`);
    if (reasoningEffort && !efforts.has(reasoningEffort)) throw new HttpError(400, `${role} 思考强度不是当前已验证的 Codex 候选`);
    if (modelId && reasoningEffort && !active.bindings.some((binding: { harnessId: string; modelId: string; available: boolean; reasoningEfforts: Array<{ id: string }> }) => binding.harnessId === 'codex' && binding.modelId === modelId && binding.available && binding.reasoningEfforts.some(item => item.id === reasoningEffort))) throw new HttpError(400, `${role} 思考强度未在所选 Codex 模型上验证`);
    return { modelId, reasoningEffort: reasoningEffort as LocalZeroConfig['allocator']['reasoningEffort'] };
  };
  const allocatorRaw = input.allocator;
  if (!allocatorRaw || typeof allocatorRaw !== 'object' || Array.isArray(allocatorRaw)) throw new HttpError(400, 'allocator 必须是对象');
  const allocatorInput = allocatorRaw as Record<string, unknown>;
  const kind = allocatorInput.kind == null ? (config.allocator.kind ?? 'codex') : allocatorInput.kind;
  if (kind !== 'codex' && kind !== 'api') throw new HttpError(400, 'allocator.kind 必须是 codex 或 api');
  let api = config.allocator.api;
  if (kind === 'api') {
    const rawApi = allocatorInput.api;
    if (!rawApi || typeof rawApi !== 'object' || Array.isArray(rawApi)) throw new HttpError(400, 'allocator.api 必须是对象');
    const value = rawApi as Record<string, unknown>;
    const baseUrl = stringField(value.baseUrl, 'allocator.api.baseUrl', 1, 2048);
    let parsedUrl: URL;
    try { parsedUrl = new URL(baseUrl); } catch { throw new HttpError(400, 'allocator.api.baseUrl 必须是有效 HTTPS URL'); }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new HttpError(400, 'allocator.api.baseUrl 必须是无凭据、查询或片段的 HTTPS URL');
    const model = stringField(value.model, 'allocator.api.model', 1, 200);
    const keyEnv = stringField(value.keyEnv, 'allocator.api.keyEnv', 1, 128);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new HttpError(400, 'allocator.api.keyEnv 必须是环境变量名');
    api = { baseUrl, model, keyEnv };
  }
  config.allocator = kind === 'api'
    ? { kind, modelId: null, reasoningEffort: null, api: api! }
    : { ...pick('allocator'), kind, ...(api ? { api } : {}) };
  config.reviewer = pick('reviewer');
  if (input.executionDefaults !== undefined) config.executionDefaults = await parseExecutionDefaults(input.executionDefaults, active, config.executionDefaults);
  await options.config.write(config);
  return { allocator: { ...config.allocator, ...(config.allocator.api ? { api: { ...config.allocator.api } } : {}) }, reviewer: config.reviewer,
    executionDefaults: { global: publicExecutionSelection(config.executionDefaults?.global ?? null), projects: Object.entries(config.executionDefaults?.projects ?? {}).map(([repoPath, execution]) => ({ repoPath, execution: publicExecutionSelection(execution)! })) } };
}

function publicExecutionSelection(selection: ExecutionSelection | null): { harnessId?: string; modelId?: string; reasoningEffort?: string } | null {
  if (!selection) return null;
  return { ...(selection.harness ? { harnessId: selection.harness } : {}), ...(selection.model ? { modelId: selection.model } : {}), ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) };
}

async function parseExecutionDefaults(raw: unknown, capability: Awaited<ReturnType<typeof capabilities>>, previous: LocalZeroConfig['executionDefaults']): Promise<NonNullable<LocalZeroConfig['executionDefaults']>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'executionDefaults 必须是对象');
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (key !== 'global' && key !== 'projects') throw new HttpError(400, `executionDefaults.${key} 不是支持的配置项`);
  const parse = (value: unknown, label: string, saved?: ExecutionSelection | null): ExecutionSelection | null => {
    if (value == null) return null;
    const parsed = parsePublicSelection(value, label);
    const selection = toExecutionSelection(parsed);
    if (!selection) throw new HttpError(400, `${label} 至少需要一个执行选项`);
    if (!sameExecutionSelection(selection, saved)) validateAvailableSelection(parsed, capability, label);
    return selection;
  };
  const global = parse(input.global ?? null, 'executionDefaults.global', previous?.global);
  if (!Array.isArray(input.projects) || input.projects.length > 500) throw new HttpError(400, 'executionDefaults.projects 必须是项目配置数组');
  const projects: Record<string, ExecutionSelection> = {};
  for (const [index, rawProject] of input.projects.entries()) {
    if (!rawProject || typeof rawProject !== 'object' || Array.isArray(rawProject)) throw new HttpError(400, `executionDefaults.projects[${index}] 必须是对象`);
    const project = rawProject as Record<string, unknown>;
    if (Object.keys(project).some(key => key !== 'repoPath' && key !== 'execution')) throw new HttpError(400, `executionDefaults.projects[${index}] 包含不支持的字段`);
    const rawPath = stringField(project.repoPath, `executionDefaults.projects[${index}].repoPath`, 1, 4096);
    const repoPath = await canonicalRepositoryPath(rawPath, `executionDefaults.projects[${index}].repoPath`);
    if (projects[repoPath]) throw new HttpError(400, `项目仓库重复：${repoPath}`);
    const savedProject = previous?.projects[repoPath];
    const execution = parse(project.execution, `executionDefaults.projects[${index}].execution`, savedProject);
    if (!execution) throw new HttpError(400, `executionDefaults.projects[${index}].execution 至少需要一个执行选项`);
    const effective = { ...selectionFields(global), ...selectionFields(execution) };
    const savedEffective = { ...selectionFields(previous?.global ?? null), ...selectionFields(savedProject ?? null) };
    // Keeping a project row cannot grandfather a changed inherited selection.
    if (!savedProject || !sameExecutionSelection(effective, savedEffective)) {
      validateAvailableSelection(effective, capability, `executionDefaults.projects[${index}] effective selection`);
    }
    projects[repoPath] = execution;
  }
  return { global, projects };
}

function sameExecutionSelection(left: ExecutionSelection | null | undefined, right: ExecutionSelection | null | undefined): boolean {
  return left?.harness === right?.harness && left?.model === right?.model && left?.reasoningEffort === right?.reasoningEffort;
}

function selectionFields(selection: ExecutionSelection | null): Record<string, string> {
  if (!selection) return {};
  return { ...(selection.harness ? { harness: selection.harness } : {}), ...(selection.model ? { model: selection.model } : {}),
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) };
}

async function canonicalRepositoryPath(rawPath: string, label: string): Promise<string> {
  if (!isAbsolute(rawPath)) throw new HttpError(400, `${label} 必须是绝对路径`);
  let repoPath: string;
  try { repoPath = await realpath(rawPath); } catch { throw new HttpError(400, `${label} 不存在或无法访问`); }
  if (!(await stat(repoPath)).isDirectory()) throw new HttpError(400, `${label} 必须是目录`);
  const git = spawnSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (git.error || git.status !== 0) throw new HttpError(400, `${label} 必须是可访问的 Git 工作区`);
  const root = await realpath(git.stdout.trim()).catch(() => undefined);
  if (!root) throw new HttpError(400, `${label} 无法解析为 Git 仓库根目录`);
  return root;
}

async function parseSubmission(raw: unknown, options: ZeroServerOptions, capabilitySnapshot?: Awaited<ReturnType<typeof capabilities>>): Promise<TaskSubmission> {
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
  const capability = capabilitySnapshot ?? await capabilities(options);
  // Match runtime precedence at the canonical repository root, but persist only
  // user-authored locks so future routes still observe current project settings.
  const defaults = (await options.config.read()).executionDefaults;
  const inherited = { ...selectionFields(defaults?.global ?? null), ...selectionFields(defaults?.projects[repoPath] ?? null) };
  if (input.executionStages !== undefined) {
    const global = input.execution == null ? {} : parsePublicSelection(input.execution, 'execution');
    const stages = validateExecutionStages(input.executionStages, { ...inherited, ...global }, capability);
    const selection = toExecutionSelection(global);
    return { repoPath, baseRef, prompt, acceptanceCriteria: criteria, maxRevisions, checks,
      ...(selection ? { selection } : {}), executionStages: stages };
  }
  const selection = input.execution == null ? undefined : validateSelection(input.execution, capability);
  validateAvailableSelection({ ...inherited, ...selectionFields(selection ?? null) }, capability, 'execution effective selection');
  return { repoPath, baseRef, prompt, acceptanceCriteria: criteria, maxRevisions, checks, ...(selection ? { selection } : {}) };
}

function validateExecutionStages(rawStages: unknown, global: Record<string, string>, capability: Awaited<ReturnType<typeof capabilities>>): NonNullable<TaskSubmission['executionStages']> {
  if (!Array.isArray(rawStages) || rawStages.length < 1 || rawStages.length > 16) throw new HttpError(400, 'executionStages 必须包含 1 到 16 个阶段');
  return rawStages.map((rawStage, index) => {
    const label = `executionStages[${index}]`;
    if (!rawStage || typeof rawStage !== 'object' || Array.isArray(rawStage)) throw new HttpError(400, `${label} 必须是对象`);
    const { objective, ...selection } = rawStage as Record<string, unknown>;
    const stage = parsePublicSelection(selection, label);
    const merged = { ...global, ...stage };
    validateAvailableSelection(merged, capability, label);
    if (Object.hasOwn(rawStage, 'objective')) {
      if (typeof objective !== 'string' || !objective.trim() || objective.trim().length > 4000) {
        throw new HttpError(400, `${label}.objective 必须是 1 到 4000 个字符的非空文本`);
      }
      return { ...stage, objective: objective.trim() };
    }
    return stage;
  });
}

function parsePublicSelection(raw: unknown, label: string): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `${label} 必须是对象`);
  const input = raw as Record<string, unknown>;
  const fields = { harnessId: 'harness', modelId: 'model', reasoningEffort: 'reasoningEffort' } as const;
  for (const key of Object.keys(input)) if (!(key in fields)) throw new HttpError(400, `${label}.${key} 不是支持的执行选项`);
  const result: Record<string, string> = {};
  for (const [publicField, internalField] of Object.entries(fields) as Array<[keyof typeof fields, string]>) {
    const value = nullableString(input[publicField], `${label}.${publicField}`);
    if (value) result[internalField] = value;
  }
  return result;
}

function validateAvailableSelection(selection: Record<string, string>, capability: Awaited<ReturnType<typeof capabilities>>, label: string): void {
  const { harness, model, reasoningEffort } = selection;
  const candidates = capability.bindings.filter(binding => binding.available && (!harness || binding.harnessId === harness) && (!model || binding.modelId === model));
  if ((harness || model || reasoningEffort) && !candidates.length) throw new HttpError(400, `${label} 没有通过验证的可用 Harness 与模型组合`);
  if (reasoningEffort && !candidates.some(binding => binding.reasoningEfforts.some((item: { id: string }) => item.id === reasoningEffort))) {
    throw new HttpError(400, `${label} 的 Harness、模型与思考强度没有已验证的可用组合`);
  }
}

function toExecutionSelection(selection: Record<string, string>): NonNullable<TaskSubmission['selection']> | undefined {
  const { harness, model, reasoningEffort } = selection;
  if (!harness && !model && !reasoningEffort) return undefined;
  return { ...(harness ? { harness } : {}), ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
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
    if (argv.some(arg => arg.startsWith('@(') || arg.startsWith('$('))) throw new HttpError(400, `第 ${index + 1} 条检查命令参数无效`);
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
  const stopped = options.cancel ? await options.cancel(id) : false;
  if (!stopped) throw new HttpError(503, 'Worker 未确认取消请求；任务状态保持不变');
  json(res, 202, { ok: true, status: task.status });
}

async function taskDetail(res: ServerResponse, id: string, options: ZeroServerOptions): Promise<void> {
  const task = options.store.get(id);
  if (!task) throw new HttpError(404, '任务不存在');
  const attempts = options.store.attempts(id);
  const checks = options.store.checks(id);
  const reviews = options.store.reviews(id);
  const events = options.store.events(id);
  const route = options.store.getRoute(id);
  const stages = options.store.stages?.(id) ?? [];
  const handoffs = options.store.handoffs?.(id) ?? [];
  const evidence = selectTaskCheckEvidence({ task, attempts, events, checks,
    runs: options.store.checkRuns?.(id), results: options.store.checkRunResults?.bind(options.store),
    integrityFailure: runId => options.store.checkRunIntegrityFailure?.(runId)
      ? 'Worktree changed during validation; passing command exits do not validate the final checkout.' : undefined });
  const attemptDetails = await Promise.all(attempts.map(async attempt => {
    const stdout = await readArtifactText(attempt.stdoutPath, options.artifactRoot);
    const stderr = await readArtifactText(attempt.stderrPath, options.artifactRoot);
    const text = [stdout ? `--- stdout ---\n${stdout}` : '', stderr ? `--- stderr ---\n${stderr}` : ''].filter(Boolean).join('\n');
    return { ...mapAttempt(attempt), ...(text ? { logs: text } : {}) };
  }));
  const logs = attemptDetails.map((attempt, index) => attempt.logs ? `Attempt ${index + 1}\n${attempt.logs}` : '').filter(Boolean).join('\n\n');
  const readCheck = async (check: CheckResult) => {
    const stdout = await readArtifactText(check.stdoutPath, options.artifactRoot);
    const stderr = await readArtifactText(check.stderrPath, options.artifactRoot);
    const output = [check.error, stdout ? `--- stdout ---\n${stdout}` : '', stderr ? `--- stderr ---\n${stderr}` : ''].filter(Boolean).join('\n');
    return { ...mapCheck(check), output: output || undefined };
  };
  const [checkDetails, historicalTests] = await Promise.all([
    Promise.all(evidence.tests.map(readCheck)), Promise.all(evidence.historicalTests.map(readCheck)),
  ]);
  const reportPath = options.artifactRoot && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? join(resolve(options.artifactRoot), id, 'report.json') : undefined;
  const report = reportPath && (await access(reportPath).then(() => true).catch(() => false)) ? `/api/tasks/${encodeURIComponent(id)}/report` : undefined;
  json(res, 200, { ...mapTaskList(task), prompt: task.prompt, acceptanceCriteria: task.acceptanceCriteria?.join('\n'), baseRef: task.baseRef,
    maxRevisions: task.maxRevisions, route: route ? mapRoute(route) : undefined,
    executionStages: (task.executionStages ?? []).map(stage => ({ ...publicExecutionSelection(stage), ...(stage.objective !== undefined ? { objective: stage.objective } : {}) })),
    stages: stages.map(mapStage), handoffs: handoffs.map(mapHandoff),
    attempts: attemptDetails, tests: checkDetails, historicalTests, checkEvidence: evidence.checkEvidence,
    review: reviews.length ? mapReview(reviews.at(-1)!) : undefined,
    logs, report, error: task.failureReason, events: events.map(event => ({ type: event.type, at: event.at, payload: event.payload })) });
}

function mapTaskList(task: TaskRecord) {
  const route = task.route;
  return { id: task.id, title: task.prompt.split(/\r?\n/, 1)[0]?.slice(0, 100), status: task.status,
    repoPath: task.repoPath, baseRef: task.baseRef, createdAt: task.createdAt, updatedAt: task.updatedAt,
    maxRevisions: task.maxRevisions, route: route ? mapRoute(route as unknown as Record<string, unknown>) : undefined,
    retryAt: task.status === 'waiting' ? task.retryAt : undefined, error: task.failureReason,
    recoveryReason: task.recoveryReason, recoveryEvidence: task.recoveryEvidence };
}
function mapSequence(sequence: TaskSequenceRecord & { goalReview?: SequenceGoalReview }) {
  return {
    id: sequence.id,
    status: sequence.status,
    objective: sequence.objective,
    acceptanceCriteria: sequence.acceptanceCriteria,
    maxGoalRevisions: sequence.maxGoalRevisions,
    goalRevisionCount: sequence.goalRevisionCount,
    createdAt: sequence.createdAt,
    updatedAt: sequence.updatedAt,
    blockedReason: sequence.blockedReason,
    ...(sequence.goalReview ? { goalReview: mapSequenceGoalReview(sequence.goalReview) } : {}),
    steps: sequence.steps.map(step => ({
      position: step.position,
      task: mapTaskList(step.task),
      ...(step.effectiveBaseCommit ? { effectiveBaseCommit: step.effectiveBaseCommit } : {}),
    })),
  };
}
function mapSequenceGoalReview(review: SequenceGoalReview) {
  return {
    state: review.state,
    ...(review.attemptId ? { attemptId: review.attemptId } : {}),
    ...(review.retryRequestedAt ? { retryRequestedAt: review.retryRequestedAt } : {}),
    ...(review.result ? { result: { ...mapReview(review.result),
      ...(review.result.targetTaskId ? { targetTaskId: review.result.targetTaskId } : {}) } } : {}),
    ...(review.retryAt ? { retryAt: review.retryAt } : {}),
    createdAt: review.createdAt,
    ...(review.completedAt ? { completedAt: review.completedAt } : {}),
  };
}
function mapRoute(route: Record<string, unknown> | RouteDecision) { const value = route as Record<string, unknown>; return { harnessId: value.harness, modelId: value.model, reasoningEffort: value.effectiveReasoningEffort ?? value.reasoningEffort, selectionSource: value.selectionSource, reason: value.reason }; }
function mapAttempt(value: Attempt) {
  const metadata = value.metadata ?? {};
  const executorSummary = typeof metadata.executorSummary === 'string' && metadata.executorSummary.trim() ? metadata.executorSummary : undefined;
  return { id: value.id, stageId: value.stageId, role: value.role, exitCode: value.exitCode,
    number: value.sequence, status: value.status, startedAt: value.startedAt, endedAt: value.finishedAt,
    route: value.harness || value.model ? { harnessId: value.harness, modelId: value.model, reasoningEffort: value.reasoningEffort } : undefined,
    sessionId: typeof metadata.sessionId === 'string' ? metadata.sessionId : undefined,
    summary: value.error ?? executorSummary ?? metadata.summary, executorSummary };
}
function mapStage(value: StageRecord) {
  return {
    id: value.id, sequence: value.sequence, role: value.role, status: value.status, predecessorStageId: value.predecessorStageId,
    harness: value.harness, harnessVersion: value.harnessVersion, model: value.model, reasoningEffort: value.reasoningEffort,
    inputFingerprint: value.inputFingerprint, outputFingerprint: value.outputFingerprint,
    createdAt: value.createdAt, startedAt: value.startedAt, finishedAt: value.finishedAt, error: value.error,
  };
}
function mapHandoff(value: HandoffRecord) {
  return {
    id: value.id, stageId: value.stageId, createdAt: value.createdAt,
    source: { attemptId: value.source.attemptId, harness: value.source.harness, model: value.source.model },
    workspace: {
      baseCommit: value.workspace.baseCommit, headCommit: value.workspace.headCommit, fingerprint: value.workspace.fingerprint,
      state: value.workspace.state, changedFiles: value.workspace.changedFiles,
    },
    completed: value.completed, currentState: value.currentState, executorSummary: value.executorSummary,
    decisions: value.decisions.map(item => ({ decision: item.decision, rationale: item.rationale })),
    keyFiles: value.keyFiles.map(item => ({ path: item.path, reason: item.reason })),
    checks: value.checks.map(item => ({ id: item.id, status: item.status, evidence: item.evidence })),
    blockers: value.blockers, risks: value.risks, nextSteps: value.nextSteps,
  };
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
  report.task = task;
  report.finalStatus = task.status;
  if (task.status === 'failed') report.error = task.failureReason;
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
