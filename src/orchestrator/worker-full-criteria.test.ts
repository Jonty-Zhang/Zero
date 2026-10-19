import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TaskStore } from '../core/task-store.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TestRunner } from '../core/test-runner.js';
import { QuotaLimitError } from '../core/quota.js';
import { HANDOFF_V1_MAX_BYTES, parseHandoffV1 } from '../domain/handoff.js';
import type { HarnessAdapter, RunRequest } from '../domain/types.js';
import { TaskWorker } from './worker.js';

const exec = promisify(execFile);
const guardian = (id: string) => ({ id: id.repeat(32), lockId: 'a'.repeat(64), predecessorDrained: true, evidenceKind: 'guardian_startup_verified' as const });

async function scenario(criteria: string[], pause?: 'route' | 'execute') {
  const root = await mkdtemp(join(process.cwd(), '.zero-full-criteria-')); const repo = join(root, 'repo'); const db = join(root, 'tasks.sqlite');
  await mkdir(repo); for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) await exec('git', args, { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'seed.txt'), 'base\n'); await exec('git', ['add', '.'], { cwd: repo }); await exec('git', ['commit', '-m', 'fixture'], { cwd: repo });
  let store = new TaskStore(db, guardian('1')); const requests: RunRequest[] = []; let paused = false;
  const worker = () => new TaskWorker({ store, worktrees: new GitWorktreeManager(join(root, 'worktrees')), testRunner: new TestRunner({ logDirectory: join(root, 'checks') }),
    router: { async route(task) {
      if (pause === 'route' && task.selection!.harness === 'writer-b' && !paused) { paused = true; throw new QuotaLimitError('Local route quota fixture', new Date(Date.now() + 60000).toISOString()); }
      return { taskId: task.id, harness: task.selection!.harness!, model: 'fixture', selectionSource: 'task', reason: 'fixture', decidedAt: new Date().toISOString() };
    } }, reviewer: { async review() { return { harness: 'codex', model: 'fake-review', exitCode: 0, result: { verdict: 'pass', summary: 'Approved', findings: [] } }; } },
    adapters: new Map(['writer-a', 'writer-b'].map(id => [id, { id, async probe() { return { harness: id, available: true, models: ['fixture'] }; },
      async run(request: RunRequest) {
        requests.push(request);
        for (const [index, criterion] of criteria.entries()) assert.ok(request.prompt.includes(criterion), `${id} must receive complete criterion ${index + 1} on every implementation request`);
        await writeFile(join(request.cwd, 'result.txt'), id === 'writer-a' ? 'prepared' : 'approved');
        if (pause === 'execute' && id === 'writer-b' && !paused) { paused = true; return { status: 'failed', exitCode: 1, durationMs: 1,
          quota: { source: 'provider_message', retryAt: new Date(Date.now() + 60000).toISOString() } }; }
        return { status: 'completed', exitCode: 0, durationMs: 1, final: 'Prepared work for the next independent phase.' };
      } } as HarnessAdapter])), artifactRoot: join(root, 'artifacts') });
  try {
    const task = store.submit({ repoPath: repo, baseRef: 'main', prompt: 'Implement every accepted criterion in the requested two-stage feature.', acceptanceCriteria: criteria, maxRevisions: 0,
      executionStages: [{ harness: 'writer-a', model: 'fixture', objective: 'Prepare phase A.' }, { harness: 'writer-b', model: 'fixture', objective: 'Complete phase B.' }],
      checks: [{ id: 'approved', argv: [process.execPath, '-e', "process.exit(require('node:fs').readFileSync('result.txt','utf8') === 'approved' ? 0 : 1)"] }] });
    assert.equal(store.claimNext('first-owner')?.id, task.id); let result = await worker().runClaimed(task.id, 'first-owner');
    if (pause) {
      assert.equal(result.status, 'waiting', result.failureReason); assert.equal(result.revisionCount, 0);
      const checkpoint = result.resumeCheckpoint!; assert.equal(checkpoint.executionStageIndex, 1);
      const now = new Date(Date.parse(result.retryAt!) + 1000); store.close(); store = new TaskStore(db, guardian('2'));
      assert.equal(store.claimNext('resumed-owner', 60000, now)?.id, task.id); result = await worker().runClaimed(task.id, 'resumed-owner');
    }
    assert.equal(result.status, 'done', result.failureReason); assert.equal(result.revisionCount, 0);
    assert.equal(requests.filter(r => r.harness === 'writer-a').length, 1, 'completed first stage must not replay on quota resume');
    assert.equal(requests.filter(r => r.harness === 'writer-b').length, pause === 'execute' ? 2 : 1);
    assert.ok(requests.every(r => r.prompt.includes('Acceptance criteria:') === (criteria.length > 0) && criteria.every(c => r.prompt.includes(c))));
    assert.ok(requests.every(r => r.model === 'fixture' && r.prompt.includes(r.harness === 'writer-a' ? 'Prepare phase A.' : 'Complete phase B.')));
    assert.deepEqual(store.get(task.id)?.acceptanceCriteria, criteria);
    assert.deepEqual(store.get(task.id)?.executionStages, task.executionStages);
    assert.deepEqual(store.get(task.id)?.checks, task.checks);
    const handoffs = store.handoffs(task.id); assert.ok(handoffs.length >= 2);
    for (const handoff of handoffs) {
      const { id: _id, byteLength: _byteLength, ...payload } = handoff;
      parseHandoffV1(payload); assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= HANDOFF_V1_MAX_BYTES);
      assert.ok(handoff.task.acceptanceCriteria.length <= 20); assert.ok(handoff.task.acceptanceCriteria.every(c => c.length <= 1000));
    }
    if (criteria.length > 20) assert.ok(handoffs.every(h => !h.task.acceptanceCriteria.includes(criteria.at(-1)!)), 'handoff display stays projected while direct implementation input stays complete');
    if (criteria.some(c => c.length > 1000)) assert.ok(handoffs.every(h => h.task.acceptanceCriteria[0]!.includes('Truncated;')));
    assert.equal(store.commitOperations(task.id).filter(op => op.status === 'applied').length, 1);
    assert.equal(store.reportOperations(task.id)[0]?.status, 'complete');
  } finally {
    store.close();
    const actualRoot = await realpath(root);
    if (dirname(actualRoot) !== await realpath(process.cwd()) || !basename(actualRoot).startsWith('.zero-full-criteria-')) {
      throw new Error('Refusing to remove a fixture outside the exact generated test directory');
    }
    await rm(actualRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

for (const count of [0, 20, 21, 100]) test(`${count} short criteria reach both agents on their first pass without spending a revision`, async () => {
  await scenario(Array.from({ length: count }, (_, i) => `Preserve unique acceptance condition ${i + 1}.`));
});
test('one criterion beyond the handoff 1000-character projection reaches both agents in full', async () => {
  await scenario(['Detailed requirement: ' + 'x'.repeat(1200) + ' Preserve the trailing required behavior.']);
});
for (const pause of ['route', 'execute'] as const) test(`all original criteria survive ${pause} quota and guardian restart for the correct next writer`, async () => {
  await scenario([...Array.from({ length: 20 }, (_, i) => `Preserve condition ${i + 1}.`), 'Retain the final hidden-before-fix criterion and its required visible output.'], pause);
});
