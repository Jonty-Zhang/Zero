import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BossPlan, HarnessAdapter, RunRequest, RunResult } from '../domain/types.js';
import { TaskStore } from '../core/task-store.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TestRunner } from '../core/test-runner.js';
import { prepareProjectFolder } from '../server/project-folders.js';
import { BossOrchestrator } from './boss.js';
import { TaskRouter, type RouteCandidate } from './router.js';
import { TaskReviewer } from './reviewer.js';
import { TaskWorker } from './worker.js';
import { createZeroServer } from '../server/server.js';
import { QuotaLimitError } from '../core/quota.js';
import { DatabaseSync } from 'node:sqlite';

const complete = (final: string): RunResult => ({ status: 'completed', exitCode: 0, durationMs: 1, final });
async function fixture() {
  const base = join(process.cwd(), 'data/verification/boss-worker-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'worker-'));
  const repo = join(root, 'project'); await mkdir(repo);
  await writeFile(join(repo, 'README.md'), 'A local project.\n');
  await prepareProjectFolder(repo);
  return { root, repo, store: new TaskStore(join(root, 'queue.sqlite')), worktrees: new GitWorktreeManager(join(root, 'worktrees')) };
}

test('one objective drives Boss consultation, cross-harness work, adaptive delegation, real checks and fresh acceptance', async () => {
  const { root, repo, store, worktrees } = await fixture();
  try {
    const task = store.submit({ repoPath: repo, baseRef: 'HEAD', prompt: 'Create a two-stage product with an export feature', boss: { preference: 'codex lead high' } });
    const requests: RunRequest[] = [];
    let actions = 0;
    let consultations = 0;
    let reviews = 0;
    const candidates: RouteCandidate[] = ['codex:lead', 'dsh:cheap', 'zcode:builder'].map(bindingId => {
      const [harness, model] = bindingId.split(':');
      return { bindingId, harness: harness!, model: model!, available: true, verified: true, healthy: true,
        reasoningEfforts: harness === 'codex' ? ['high'] : [], capabilities: harness === 'codex' ? ['route', 'review'] : ['implement', 'revise'] };
    });
    const plan = (second: boolean) => ({ action: 'plan', summary: second ? 'Adapted to the observed implementation and user message' : 'Implement storage then integrate export',
      consultantBindingId: null, consultantEffort: null, question: null, acceptanceCriteria: ['The final product includes export'], maxRevisions: 2,
      stages: second ? [{ bindingId: 'zcode:builder', reasoningEffort: null, objective: 'Integrate export after reading the storage implementation and latest user requirement' }]
        : [{ bindingId: 'dsh:cheap', reasoningEffort: null, objective: 'Implement the storage foundation' }, { bindingId: 'dsh:cheap', reasoningEffort: null, objective: 'Provisional integration pending observed results' }],
      checks: [{ id: 'product', argv: [process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'integrated-export')"] }] });
    const codex: HarnessAdapter = { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['lead'], reasoningEfforts: ['high'], roles: ['route', 'review'] }; },
      async run(request) {
        requests.push(request);
        assert.equal(request.model, 'lead');
        if (request.role === 'review') {
          reviews++;
          assert.equal(await readFile(join(request.cwd, 'review-context/project/result.txt'), 'utf8'), 'integrated-export');
          assert.match(request.prompt, /final product includes export/);
          return complete(JSON.stringify({ verdict: 'pass', summary: 'Observed final result and real automated check satisfy the objective', findings: [] }));
        }
        const schema = JSON.parse(await readFile(request.outputSchemaPath!, 'utf8'));
        if (schema.properties.bindingId && !schema.properties.taskType) return complete(JSON.stringify({ bindingId: 'codex:lead', reasoningEffort: 'high', reason: 'Matched the requested available lead' }));
        if (schema.properties.action) {
          actions++;
          if (actions === 1) return complete(JSON.stringify({ action: 'consult', summary: 'Ask an independent implementation model about design risks', consultantBindingId: 'dsh:cheap', consultantEffort: null,
            question: 'What storage and export acceptance evidence is needed?', acceptanceCriteria: [], stages: [], checks: [], maxRevisions: 0 }));
          if (actions === 2) { assert.match(request.prompt, /independent design opinion/); return complete(JSON.stringify(plan(false))); }
          assert.match(request.prompt, /export must preserve names/);
          assert.equal(await readFile(join(request.cwd, 'review-context/project/result.txt'), 'utf8'), 'storage');
          return complete(JSON.stringify(plan(true)));
        }
        const payload = JSON.parse(request.prompt.split('\n\n').at(-1)!);
        const candidate = payload.eligibleCandidates[0];
        return complete(JSON.stringify({ taskType: 'implementation', complexity: 'medium', bindingId: candidate.bindingId, reasoningEffort: null, reason: 'Execute the project lead stage on the selected verified worker' }));
      } };
    const workerAdapter = (id: 'dsh' | 'zcode', model: string): HarnessAdapter => ({ id,
      async probe() { return { harness: id, available: true, models: [model], roles: ['implement', 'revise'] }; },
      async run(request) {
        requests.push(request);
        if (request.artifactDir?.includes('boss_consult')) {
          consultations++;
          assert.notEqual(request.cwd, join(root, 'worktrees', task.id));
          await writeFile(join(request.cwd, 'discarded-consultation.txt'), 'must never enter result');
          return complete('independent design opinion: verify export preserves names with a real artifact assertion');
        }
        if (id === 'dsh') {
          await writeFile(join(request.cwd, 'result.txt'), 'storage');
          store.addBossMessage(task.id, 'user', 'The export must preserve names');
        } else {
          assert.match(request.prompt, /Integrate export/);
          assert.equal(await readFile(join(request.cwd, 'result.txt'), 'utf8'), 'storage');
          await writeFile(join(request.cwd, 'result.txt'), 'integrated-export');
        }
        return complete(id === 'dsh' ? 'Storage is ready; integrate export next' : 'Export integration is complete');
      } });
    const adapters = new Map([['codex', codex], ['dsh', workerAdapter('dsh', 'cheap')], ['zcode', workerAdapter('zcode', 'builder')]]);
    const artifactRoot = join(root, 'artifacts');
    const boss = new BossOrchestrator({ codex, adapters, artifactRoot, getCandidates: async () => candidates });
    const router = new TaskRouter({ codex, coordinatorModel: 'lead', coordinatorReasoningEffort: 'high', cwd: repo, artifactDir: artifactRoot, getCandidates: async () => candidates });
    const reviewer = new TaskReviewer({ codex, model: 'lead', reasoningEffort: 'high', artifactDir: artifactRoot });
    const worker = new TaskWorker({ store, worktrees, boss, router, reviewer, adapters, artifactRoot, testRunner: new TestRunner() });
    const done = await worker.runNext('boss-worker');
    assert.equal(done?.status, 'done', done?.failureReason);
    assert.equal(done?.failureReason, undefined);
    assert.equal(consultations, 1); assert.equal(reviews, 1); assert.equal(actions, 3);
    assert.deepEqual(done?.executionStages?.map(stage => stage.harness), ['dsh', 'zcode']);
    assert.equal(done?.bossPlan?.messageCursor, store.bossMessages(task.id).find(message => message.role === 'user')?.id);
    const report = await worker.readReport(task.id);
    assert.equal(report?.checks[0]?.status, 'passed');
    assert.ok(report?.resultCommit);
    assert.equal(report?.handoffs?.length, 2);
    assert.equal(await readFile(join(root, 'worktrees', task.id, 'result.txt'), 'utf8'), 'integrated-export');
    await assert.rejects(readFile(join(root, 'worktrees', task.id, 'discarded-consultation.txt')), /ENOENT/);
    const attempts = store.attempts(task.id);
    assert.equal(attempts.filter(attempt => attempt.metadata?.purpose === 'boss_consult').length, 1);
    assert.equal(attempts.filter(attempt => attempt.status === 'running').length, 0);
    assert.ok(attempts.every(attempt => requests.some(request => request.attemptId === attempt.id)));
    const server = createZeroServer({ store, config: { async read() { throw new Error('detail must not probe'); }, async write() {} }, artifactRoot });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const detail = await (await fetch(`http://127.0.0.1:${address.port}/api/tasks/${task.id}`)).json() as { bossPlan: BossPlan; bossMessages: unknown[]; delivery: { path: string; branch: string; resultCommit: string } };
      assert.equal(detail.bossPlan.boss.model, 'lead'); assert.ok(detail.bossMessages.length >= 4);
      assert.equal(detail.delivery.path, join(root, 'worktrees', task.id));
      assert.equal(detail.delivery.resultCommit, report?.resultCommit);
      assert.notEqual(detail.delivery.path, repo, 'the selected source folder must never be presented as the output worktree');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('cancelling an active Boss consultation targets its actual harness and persisted attempt', async () => {
  const { root, repo, store, worktrees } = await fixture();
  let entered!: () => void; const entry = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; });
  let running: ReturnType<TaskWorker['runNext']> | undefined;
  try {
    const task = store.submit({ repoPath: repo, baseRef: 'HEAD', prompt: 'Design before implementation', boss: { preference: 'lead' } });
    let request: RunRequest | undefined;
    const cancellations: string[][] = [];
    const consultant: HarnessAdapter = { id: 'dsh', async probe() { return { harness: 'dsh', available: true, models: ['cheap'] }; },
      async run(input) { request = input; entered(); await held; return { status: 'cancelled', exitCode: null, durationMs: 1 }; },
      async cancel(taskId, attemptId) { cancellations.push([taskId, attemptId!]); finish(); } };
    const worker = new TaskWorker({ store, worktrees, testRunner: new TestRunner(), artifactRoot: join(root, 'artifacts'), adapters: new Map([['dsh', consultant]]),
      router: { async route() { throw new Error('No writer after cancellation'); } }, reviewer: { async review() { throw new Error('No review after cancellation'); } },
      boss: { async plan(_task, context) { await context.run(consultant, { cwd: context.cwd, role: 'implement', harness: 'dsh', model: 'cheap', prompt: 'Independent design discussion' }, 'boss_consult'); throw new Error('Cancelled plan cannot apply'); } } });
    running = worker.runNext('cancel-boss');
    await Promise.race([entry, running.then(result => { throw new Error(`No consultation started: ${JSON.stringify(result)}`); })]);
    assert.equal(await worker.cancel(task.id), true);
    const cancelled = await running;
    assert.equal(cancelled?.status, 'failed'); assert.equal(cancelled?.failureReason, 'Cancelled by user');
    assert.ok(cancellations.some(([id, attemptId]) => id === task.id && attemptId === request?.attemptId));
    assert.equal(store.attempts(task.id)[0]?.status, 'interrupted');
    assert.equal(store.get(task.id)?.bossPlan, undefined);
    assert.deepEqual(store.stages(task.id), []); assert.deepEqual(store.checks(task.id), []); assert.deepEqual(store.commitOperations(task.id), []);
  } finally { finish?.(); if (running) await running; store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

for (const pause of ['plan', 'writer'] as const) test(`quota in ${pause} resumes remaining Boss work without replaying a completed logical stage`, async () => {
  const { root, repo, store, worktrees } = await fixture();
  try {
    const task = store.submit({ repoPath: repo, baseRef: 'HEAD', prompt: 'Build storage then export', boss: { preference: 'lead' } });
    let plans = 0; let storageRuns = 0; let exportRuns = 0;
    const definitions: BossPlan = { summary: 'Build storage then export', acceptanceCriteria: ['Export exists'], boss: { harness: 'codex', model: 'lead' }, maxRevisions: 0,
      stages: [{ harness: 'dsh', model: 'cheap', objective: 'Store data' }, { harness: 'zcode', model: 'builder', objective: 'Export data' }],
      checks: [{ id: 'export', argv: [process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('export.txt','utf8'),'storage-export')"] }] };
    const dsh: HarnessAdapter = { id: 'dsh', async probe() { return { harness: 'dsh', available: true, models: ['cheap'] }; }, async run(request) {
      storageRuns++; await writeFile(join(request.cwd, 'storage.txt'), storageRuns === 1 && pause === 'writer' ? 'partial' : 'storage');
      if (pause === 'writer' && storageRuns === 1) return { status: 'failed', exitCode: 1, durationMs: 1, quota: { source: 'provider_message', retryAt: new Date(Date.now() + 60000).toISOString() } };
      return complete('Storage completed');
    } };
    const zcode: HarnessAdapter = { id: 'zcode', async probe() { return { harness: 'zcode', available: true, models: ['builder'] }; }, async run(request) { exportRuns++; await writeFile(join(request.cwd, 'export.txt'), `${await readFile(join(request.cwd, 'storage.txt'), 'utf8')}-export`); return complete('Export completed'); } };
    const worker = new TaskWorker({ store, worktrees, testRunner: new TestRunner(), artifactRoot: join(root, 'artifacts'), adapters: new Map([['dsh', dsh], ['zcode', zcode]]),
      boss: { async plan(_current, context) { plans++; if (pause === 'plan' && plans === 2) throw new QuotaLimitError('Boss planning limit', new Date(Date.now() + 60000).toISOString()); return { ...definitions, stages: context.completedStages ? definitions.stages.slice(1) : definitions.stages }; } },
      router: { async route(current) { return { taskId: current.id, harness: current.selection!.harness!, model: current.selection!.model!, reason: 'Boss chosen worker', selectionSource: 'task', decidedAt: new Date().toISOString() }; } },
      reviewer: { async review() { return { harness: 'codex', model: 'lead', exitCode: 0, result: { verdict: 'pass', summary: 'Verified export', findings: [] } }; } } });
    const waiting = await worker.runNext('before-quota');
    assert.equal(waiting?.status, 'waiting', waiting?.failureReason);
    assert.equal(waiting.resumeCheckpoint?.executionStageIndex, pause === 'writer' ? 0 : 1);
    assert.equal(storageRuns, 1); assert.equal(exportRuns, 0);
    const db = new DatabaseSync(join(root, 'queue.sqlite'));
    try { db.prepare('UPDATE quota_pauses SET retry_at=? WHERE task_id=?').run(new Date(Date.now() - 1000).toISOString(), task.id); } finally { db.close(); }
    const done = await worker.runNext('after-quota');
    assert.equal(done?.status, 'done', done?.failureReason);
    assert.equal(done?.failureReason, undefined, 'successful quota recovery clears the active error');
    assert.equal(storageRuns, pause === 'writer' ? 2 : 1, 'only the interrupted writer may resume'); assert.equal(exportRuns, 1); assert.equal(plans, pause === 'writer' ? 2 : 3);
    assert.equal(store.stages(task.id).filter(stage => stage.role === 'implement' && stage.status === 'succeeded').length, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('quota during the first Boss consultation persists a route checkpoint without starting a project writer', async () => {
  const { root, repo, store, worktrees } = await fixture();
  try {
    const task = store.submit({ repoPath: repo, baseRef: 'HEAD', prompt: 'Design a useful product', boss: { preference: 'lead' } });
    const consultant: HarnessAdapter = { id: 'dsh', async probe() { return { harness: 'dsh', available: true, models: ['cheap'] }; }, async run() { return { status: 'failed', exitCode: 1, durationMs: 1, quota: { source: 'provider_message', retryAt: new Date(Date.now() + 60000).toISOString() } }; } };
    const worker = new TaskWorker({ store, worktrees, testRunner: new TestRunner(), adapters: new Map([['dsh', consultant]]), artifactRoot: join(root, 'artifacts'),
      router: { async route() { throw new Error('writer route must not run'); } }, reviewer: { async review() { throw new Error('review must not run'); } },
      boss: { async plan(current, context) {
        await context.run(consultant, { role: 'implement', cwd: context.cwd, prompt: 'Consultation', harness: 'dsh', model: 'cheap', artifactDir: join(root, 'consultation') }, 'boss_consult');
        throw new QuotaLimitError('consultation quota', new Date(Date.now() + 60000).toISOString());
      } } });
    const waiting = await worker.runNext('quota-worker');
    assert.equal(waiting?.status, 'waiting', waiting?.failureReason);
    assert.equal(waiting?.resumeCheckpoint?.stage, 'route');
    assert.equal(store.stages(task.id).length, 0);
    assert.equal(store.attempts(task.id)[0]?.harness, 'dsh');
    assert.equal(store.attempts(task.id)[0]?.metadata?.adapterRole, 'implement');
  } finally { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
