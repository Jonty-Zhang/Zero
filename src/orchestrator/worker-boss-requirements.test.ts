import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BossMessage, BossPlan, HarnessAdapter, RunResult } from '../domain/types.js';
import type { ReviewRequirementsSnapshot } from '../domain/review-requirements.js';
import { TaskStore } from '../core/task-store.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TestRunner } from '../core/test-runner.js';
import { prepareProjectFolder } from '../server/project-folders.js';
import { TaskReviewer } from './reviewer.js';
import { TaskWorker } from './worker.js';

const complete = (final: string): RunResult => ({ status: 'completed', exitCode: 0, durationMs: 1, final });

for (const window of ['initial', 'writer', 'checks', 'review-quota'] as const) {
  test(`Boss ${window} requirements reach real acceptance, bounded rework and exact delivery receipts`, { timeout: 180_000 }, async () => {
    const fixtures = resolve('data/verification/boss-requirements-worker-tests');
    await mkdir(fixtures, { recursive: true });
    const root = await mkdtemp(join(fixtures, `${window}-`));
    assert.ok(resolve(root).startsWith(fixtures + sep));
    const repo = join(root, 'project'); await mkdir(repo);
    await writeFile(join(repo, 'README.md'), 'Synthetic acceptance project.\n');
    await prepareProjectFolder(repo);
    const database = join(root, 'queue.sqlite');
    const store = new TaskStore(database);
    try {
      const task = store.submit({ repoPath: repo, baseRef: 'HEAD', prompt: 'Implement an export feature', boss: { preference: 'Independent lead' } });
      const original = store.addBossMessageIdempotent(task.id, 'Keep the existing public export API. [original-human]', `original-human-${window}-123`);
      const requirement = `导出必须保留原始中文名称 / Preserve export names. [${window}-human]`;
      let receipt: BossMessage | undefined;
      const key = `accepted-late-${window}-123`;
      if (window === 'initial' || window === 'review-quota') receipt = store.addBossMessageIdempotent(task.id, requirement, key);
      const expectedReceipt = () => { assert.ok(receipt); return receipt; };
      const accept = () => {
        assert.equal(store.get(task.id)?.status, 'running');
        receipt = store.addBossMessageIdempotent(task.id, requirement, key);
      };
      let checkRuns = 0;
      class ObservedChecks extends TestRunner {
        override async run(...args: Parameters<TestRunner['run']>) {
          checkRuns++;
          if (window === 'checks' && checkRuns === 1) {
            assert.equal(store.checkRuns(task.id).at(-1)?.status, 'running');
            accept();
          }
          return super.run(...args);
        }
      }
      const writerRoles: string[] = [];
      const writer: HarnessAdapter = {
        id: 'dsh', async probe() { return { harness: 'dsh', available: true, models: ['cheap'] }; },
        async run(request) {
          writerRoles.push(request.role);
          if (request.role === 'implement' && window === 'writer') accept();
          if (request.role === 'revise') assert.ok(request.prompt.includes(requirement), 'the revision must preserve the human requirement');
          await writeFile(join(request.cwd, 'export.txt'), request.role === 'revise' ? 'original-names-preserved' : 'initial-export');
          return complete('Synthetic writer result.');
        },
      };
      const prompts: string[] = [];
      const snapshots: Array<ReviewRequirementsSnapshot | undefined> = [];
      let reviewCalls = 0;
      let finishedReviews = 0;
      const codex: HarnessAdapter = {
        id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['lead'], reasoningEfforts: ['high'], roles: ['review'] }; },
        async run(request) {
          assert.equal(request.role, 'review');
          prompts.push(request.prompt); reviewCalls++;
          assert.equal(store.get(task.id)?.status, 'reviewing');
          assert.deepEqual(store.addBossMessageIdempotent(task.id, requirement, key), expectedReceipt(), 'an accepted message receipt is replayable after admission closes');
          assert.throws(() => store.addBossMessageIdempotent(task.id, 'New requirement after admission closed', `fresh-review-${window}-${reviewCalls}-123`), /验收|review|任务/);
          assert.equal(store.bossMessages(task.id).filter(message => message.role === 'user').length, 2);
          if (window === 'review-quota' && reviewCalls === 1) return { status: 'failed', exitCode: 1, durationMs: 1,
            quota: { source: 'provider_message', retryAt: new Date(Date.now() + 60_000).toISOString() } };
          finishedReviews++;
          assert.equal(await readFile(join(request.cwd, 'review-context/project/export.txt'), 'utf8'), finishedReviews === 1 ? 'initial-export' : 'original-names-preserved');
          return complete(JSON.stringify(finishedReviews === 1 ? {
            verdict: 'changes_requested', summary: 'The accepted name-preservation requirement still needs implementation.',
            findings: [{ file: 'export.txt', line: 1, severity: 'high', evidence: 'The initial export does not preserve the original names.', requestedChange: 'Preserve original Chinese export names.' }],
          } : { verdict: 'pass', summary: 'The bounded revision satisfies the accepted human requirement.', findings: [] }));
        },
      };
      const artifacts = join(root, 'artifacts');
      const plan: BossPlan = { summary: 'Implement and independently accept export', acceptanceCriteria: ['Export exists'], boss: { harness: 'codex', model: 'lead', reasoningEffort: 'high' },
        messageCursor: original.id, maxRevisions: 1, stages: [{ harness: 'dsh', model: 'cheap', objective: 'Implement export' }],
        checks: [{ id: 'export-file', argv: [process.execPath, '-e', "require('node:assert/strict').ok(require('node:fs').existsSync('export.txt'))"] }] };
      const actualReviewer = new TaskReviewer({ codex, model: 'lead', reasoningEffort: 'high', artifactDir: artifacts });
      const worker = new TaskWorker({ store, artifactRoot: artifacts, worktrees: new GitWorktreeManager(join(root, 'worktrees')), testRunner: new ObservedChecks(),
        adapters: new Map([['dsh', writer], ['codex', codex]]), boss: { async plan() { return plan; } },
        router: { async route(current) { return { taskId: current.id, harness: 'dsh', model: 'cheap', reason: 'Synthetic route', selectionSource: 'task', decidedAt: new Date().toISOString() }; } },
        reviewer: { async review(...args) { snapshots.push(structuredClone(args[5].requirements)); return actualReviewer.review(...args); } },
      });
      let result = await worker.runNext(`before-${window}`);
      if (window === 'review-quota') {
        assert.equal(result?.status, 'waiting', result?.failureReason);
        assert.equal(result.resumeCheckpoint?.kind, 'review_quota');
        const sealed = store.reviewPackages(task.id)[0]; assert.ok(sealed?.requirements);
        assert.equal(writerRoles.length, 1); assert.equal(checkRuns, 1);
        assert.throws(() => store.addBossMessageIdempotent(task.id, 'A new requirement after sealed review quota pause', 'new-paused-review-request-123'), /验收|review|任务/);
        assert.deepEqual(store.addBossMessageIdempotent(task.id, requirement, key), expectedReceipt(), 'waiting review-quota still replays an accepted exact receipt');
        assert.equal(store.bossMessages(task.id).filter(message => message.role === 'user').length, 2);
        const sql = new DatabaseSync(database);
        try { sql.prepare('UPDATE quota_pauses SET retry_at=? WHERE task_id=?').run(new Date(Date.now() - 1000).toISOString(), task.id); } finally { sql.close(); }
        result = await worker.runNext(`resume-${window}`);
        assert.deepEqual(snapshots[0], snapshots[1], 'quota recovery reuses the original sealed human requirements');
        assert.deepEqual(store.reviewPackages(task.id)[0]?.requirements, sealed.requirements, 'resume does not rewrite its first package');
      }
      assert.equal(result?.status, 'done', result?.failureReason);
      assert.deepEqual(writerRoles, ['implement', 'revise']);
      assert.equal(checkRuns, 2); assert.equal(finishedReviews, 2);
      assert.equal(reviewCalls, window === 'review-quota' ? 3 : 2);
      for (const prompt of prompts) {
        assert.ok(prompt.includes(original.content), 'actual reviewer sees the original accepted human wording');
        assert.ok(prompt.includes(requirement), `actual reviewer sees accepted ${window} wording`);
      }
      for (const pkg of store.reviewPackages(task.id)) {
        assert.ok(pkg.requirements);
        assert.equal(pkg.requirements.prompt, task.prompt);
        assert.deepEqual(pkg.requirements.acceptanceCriteria, plan.acceptanceCriteria);
        assert.deepEqual(pkg.requirements.userMessages, [original, expectedReceipt()]);
        assert.equal(pkg.requirements.messageCursor, expectedReceipt().id);
      }
    } finally {
      store.close();
      assert.ok(resolve(root).startsWith(fixtures + sep));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
