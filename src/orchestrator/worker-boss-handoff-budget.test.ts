import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { HarnessAdapter, RunResult } from '../domain/types.js';
import { TaskStore } from '../core/task-store.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TestRunner } from '../core/test-runner.js';
import { prepareProjectFolder } from '../server/project-folders.js';
import { TaskWorker } from './worker.js';
import { BossOrchestrator } from './boss.js';
import { TaskReviewer } from './reviewer.js';
import type { RouteCandidate } from './router.js';

test('large original requirements survive all 16 adaptive stages, real checks and independent acceptance', { timeout: 600_000 }, async () => {
  const base = join(process.cwd(), 'data/verification/boss-handoff-round30');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'integration-'));
  const repo = join(root, 'project'); await mkdir(repo);
  await writeFile(join(repo, 'seed.txt'), 'seed\n'); await prepareProjectFolder(repo);
  const store = new TaskStore(join(root, 'queue.sqlite'));
  const complete = (final: string): RunResult => ({ status: 'completed', exitCode: 0, durationMs: 1, final });
  const criteria = Array.from({ length: 20 }, (_, i) => `Requirement ${i + 1}: ` + 'a'.repeat(970));
  const objective = 'Build the integration. ' + 'b'.repeat(7900);
  let writers = 0, plans = 0, reviews = 0;
  const codex: HarnessAdapter = { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['lead'], reasoningEfforts: ['high'], roles: ['route', 'review'] }; }, async run(request) {
    if (request.role === 'review') {
      reviews++;
      assert.equal(await readFile(join(request.cwd, 'review-context/project/result.txt'), 'utf8'), '16');
      for (const criterion of criteria) assert.ok(request.prompt.includes(criterion));
      return complete(JSON.stringify({ verdict: 'pass', summary: 'Artifact and real checks establish completion', findings: [], userMessageReplies: [] }));
    }
    const schema = JSON.parse(await readFile(request.outputSchemaPath!, 'utf8'));
    if (schema.properties.bindingId) return complete(JSON.stringify({ bindingId: 'codex:lead', reasoningEffort: 'high', reason: 'Available lead' }));
    plans++;
    assert.ok(request.prompt.includes(objective));
    for (const criterion of criteria) assert.ok(request.prompt.includes(criterion));
    {
      const input = JSON.parse(request.prompt.split('\n').find(line => line.startsWith('{"objective":'))!);
      assert.equal(input.handoffContext.projections.length, writers);
      assert.equal(input.handoffContext.omittedCount, 0);
      for (const [index, projection] of input.handoffContext.projections.entries() as ArrayIterator<[number, string]>) {
        assert.match(projection, /UNTRUSTED/); assert.match(projection, /fingerprint/);
        assert.match(projection, /attemptId/); assert.match(projection, /next component is ready/);
        assert.ok(!projection.includes(objective));
        const persisted = store.handoffs(request.taskId)[index]!;
        const rendered = JSON.parse(projection.slice(projection.indexOf('{')));
        assert.equal(rendered.source.attemptId, persisted.source.attemptId);
        assert.equal(rendered.workspace.fingerprint, persisted.workspace.fingerprint);
      }
    }
    return complete(JSON.stringify({ action: 'plan', summary: 'Continue the remaining bounded stages', consultantBindingId: null, consultantEffort: null, question: null, acceptanceCriteria: criteria,
      maxRevisions: 0, stages: Array.from({ length: 16 - writers }, () => ({ bindingId: 'dsh:cheap', reasoningEffort: null, objective: 'Complete the next integration component' })),
      checks: [{ id: 'product', argv: [process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'16')"] }] }));
  } };
  const dsh: HarnessAdapter = { id: 'dsh', async probe() { return { harness: 'dsh', available: true, models: ['cheap'], roles: ['implement', 'revise'] }; }, async run(request) {
    writers++; await writeFile(join(request.cwd, 'result.txt'), String(writers)); return complete('The next component is ready.');
  } };
  const adapters = new Map([['codex', codex], ['dsh', dsh]]);
  const candidates: RouteCandidate[] = [{ bindingId: 'codex:lead', harness: 'codex', model: 'lead', reasoningEfforts: ['high'], capabilities: ['route', 'review'], verified: true, available: true, healthy: true },
    { bindingId: 'dsh:cheap', harness: 'dsh', model: 'cheap', reasoningEfforts: [], capabilities: ['implement', 'revise'], verified: true, available: true, healthy: true }];
  const artifactRoot = join(root, 'artifacts');
  const boss = new BossOrchestrator({ codex, adapters, artifactRoot, getCandidates: async () => candidates });
  const worker = new TaskWorker({ store, worktrees: new GitWorktreeManager(join(root, 'worktrees')), testRunner: new TestRunner(), adapters, artifactRoot, boss,
    router: { async route(task) { return { taskId: task.id, harness: task.selection!.harness!, model: task.selection!.model!, selectionSource: 'task', reason: 'Execute the lead stage', decidedAt: new Date().toISOString() }; } },
    reviewer: new TaskReviewer({ codex, model: 'lead', reasoningEffort: 'high', artifactDir: artifactRoot }) });
  try {
    const task = store.submit({ repoPath: repo, baseRef: 'HEAD', prompt: objective, acceptanceCriteria: criteria, boss: { preference: 'lead high' } });
    const done = await worker.runNext('isolated-budget-regression');
    assert.equal(done?.status, 'done', done?.failureReason);
    assert.equal(writers, 16); assert.equal(plans, 16); assert.equal(reviews, 1);
    const report = await worker.readReport(task.id);
    assert.equal(report?.checks[0]?.status, 'passed'); assert.ok(report?.resultCommit);
    assert.equal(report?.handoffs?.length, 16);
    assert.ok(store.handoffs(task.id).every(h => h.task.objective === objective && h.task.acceptanceCriteria.length === 20));
    assert.ok(store.bossMessages(task.id).every(m => m.id !== 'observed-handoffs'));
  } finally {
    store.close();
    assert.ok(resolve(root).startsWith(resolve(base) + sep));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
