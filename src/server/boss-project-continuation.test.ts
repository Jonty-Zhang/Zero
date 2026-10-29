import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { BossPlan, HarnessAdapter, TaskRecord } from '../domain/types.js';
import { TaskStore } from '../core/task-store.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TestRunner } from '../core/test-runner.js';
import { TaskWorker } from '../orchestrator/worker.js';
import { ConfigStore } from './config-store.js';
import { createZeroServer } from './server.js';
import { createConfiguredTaskReviewer } from './task-reviewer.js';

const exec = promisify(execFile);

test('continuing a Boss project starts from its delivered commit despite later original and worktree edits', { timeout: 180_000 }, async () => {
  const fixtures = resolve('data/verification/boss-continuation-round26');
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, 'workflow-'));
  assert.ok(root.startsWith(fixtures + sep));
  const repo = join(root, 'project'); await mkdir(repo);
  await writeFile(join(repo, 'README.md'), 'A project which will evolve.\n');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  const config = new ConfigStore(join(root, 'config.json'));
  const model = { id: 'lead', provider: 'openai', modelId: 'offline-lead' };
  await writeFile(config.path, JSON.stringify({ models: [model], bindings: [{ harness: 'codex', selector: 'cli_argument', verified: true, model, reasoningEfforts: ['high'] }],
    allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null },
    verifications: { 'codex:lead': { verifiedAt: '2026-10-30T00:00:00Z', cliVersion: 'offline-1', requestedModel: model.modelId,
      exitCode: 0, level: 'selector_only', reasoningEfforts: ['high'] } } }));
  const firstPrompt = 'Create a bilingual export label';
  const nextPrompt = 'Continue by adding formatted output';
  const preference = 'Codex lead high plans and accepts; DSH handles implementation';
  let writers = 0; let reviews = 0;
  const codex: HarnessAdapter = { id: 'codex',
    async probe() { return { harness: 'codex', available: true, models: ['lead'], reasoningEfforts: ['high'], roles: ['review'] }; },
    async run(request) {
      assert.equal(request.role, 'review'); assert.equal(request.model, 'lead'); assert.equal(request.reasoningEffort, 'high');
      reviews++;
      assert.equal(await readFile(join(request.cwd, 'review-context/project/result.txt'), 'utf8'), 'Export / 导出');
      return { status: 'completed', exitCode: 0, durationMs: 1,
        final: JSON.stringify({ verdict: 'pass', summary: 'Checked the requested artifact', findings: [], userMessageReplies: [] }) };
    } };
  const dsh: HarnessAdapter = { id: 'dsh', async probe() { return { harness: 'dsh', available: true, models: ['cheap'] }; },
    async run(request) {
      writers++;
      if (writers === 1) await writeFile(join(request.cwd, 'result.txt'), 'Export / 导出');
      else {
        assert.equal(await readFile(join(request.cwd, 'result.txt'), 'utf8'), 'Export / 导出', 'inherit the accepted commit, not HEAD or edited old worktree');
        await assert.rejects(readFile(join(request.cwd, 'head-only.txt')), /ENOENT/);
        await writeFile(join(request.cwd, 'formatted.txt'), '[Export / 导出]');
      }
      return { status: 'completed', exitCode: 0, durationMs: 1, final: 'Produced the requested artifact' };
    } };
  const server = createZeroServer({ store, config, adapters: { codex, dsh }, artifactRoot: join(root, 'artifacts') });
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args], { windowsHide: true })).stdout.trim();
  try {
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    const post = async (payload: unknown, key: string) => {
      const response = await fetch(`${url}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': key }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.json() as { id: string; error?: string } };
    };
    const worktrees = new GitWorktreeManager(join(root, 'worktrees'));
    const worker = new TaskWorker({ store, worktrees, testRunner: new TestRunner(), artifactRoot: join(root, 'artifacts'), adapters: new Map([['codex', codex], ['dsh', dsh]]),
      boss: { async plan(task) {
        const checks = [{ id: 'label', argv: [process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'Export / 导出')"] }];
        if (task.prompt === nextPrompt) checks.push({ id: 'formatted', argv: [process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('formatted.txt','utf8'),'[Export / 导出]')"] });
        const plan: BossPlan = { summary: task.prompt, acceptanceCriteria: [task.prompt], boss: { harness: 'codex', model: 'lead', reasoningEffort: 'high' },
          stages: [{ harness: 'dsh', model: 'cheap', objective: task.prompt }], maxRevisions: 0, checks };
        return plan;
      } }, router: { async route(task) { return { taskId: task.id, harness: 'dsh', model: 'cheap', reason: 'Execute the lead plan', selectionSource: 'task', decidedAt: new Date().toISOString() }; } },
      reviewer: createConfiguredTaskReviewer({ codex, artifactRoot: join(root, 'artifacts'), readReviewerConfig: async () => ({ modelId: null, reasoningEffort: null }) }) });
    const first = await post({ repoPath: repo, prompt: firstPrompt, boss: { preference } }, 'first-project-request-1234');
    assert.equal(first.status, 201, first.body.error);
    const firstResult = await worker.runNext('first-owner'); assert.equal(firstResult?.status, 'done', firstResult?.failureReason);
    const detailResponse = await fetch(`${url}/api/tasks/${first.body.id}`); assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as TaskRecord & { delivery: { path: string; resultCommit: string } };
    const acceptedCommit = detail.delivery.resultCommit;
    assert.match(acceptedCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    const firstStored = store.get(first.body.id);
    await writeFile(join(detail.delivery.path, 'result.txt'), 'unreviewed worktree edit');
    await writeFile(join(repo, 'head-only.txt'), 'Later unrelated original-project work');
    await git('add', 'head-only.txt');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Later original project work');
    const advancedHead = await git('rev-parse', 'HEAD'); assert.notEqual(advancedHead, acceptedCommit);
    const payload = { repoPath: detail.repoPath, baseRef: acceptedCommit, prompt: nextPrompt, boss: detail.boss };
    const next = await post(payload, 'continue-project-request-1234'); assert.equal(next.status, 201, next.body.error);
    const retry = await post(payload, 'continue-project-request-1234'); assert.equal(retry.status, 201); assert.equal(retry.body.id, next.body.id);
    const changedIdentity = await post({ ...payload, baseRef: advancedHead }, 'continue-project-request-1234'); assert.equal(changedIdentity.status, 409);
    const invalid = await post({ ...payload, baseRef: 'f'.repeat(40) }, 'missing-project-result-1234'); assert.equal(invalid.status, 400);
    assert.equal(store.list().length, 2, 'retries or missing result objects must not add tasks');
    assert.equal(store.get(next.body.id)?.baseRef, acceptedCommit);
    const final = await worker.runNext('continued-owner'); assert.equal(final?.status, 'done', final?.failureReason);
    const creation = store.getWorktreeCreation(next.body.id)!;
    assert.equal((creation.plan as { baseCommit: string }).baseCommit, acceptedCommit);
    assert.equal(await readFile(join(root, 'worktrees', next.body.id, 'formatted.txt'), 'utf8'), '[Export / 导出]');
    assert.deepEqual(store.get(first.body.id), firstStored, 'continuing must not rewrite the completed task');
    assert.equal(await git('rev-parse', 'HEAD'), advancedHead, 'neither result is merged into the original branch');
    assert.equal(writers, 2); assert.equal(reviews, 2);
    await writeFile(join(fixtures, 'workflow-evidence.json'), JSON.stringify({ sourceTask: first.body.id, nextTask: next.body.id,
      acceptedCommit, advancedHead, effectiveBase: (creation.plan as { baseCommit: string }).baseCommit, status: final.status, writers, reviews, retryStatus: retry.status }, null, 2));
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); store.close();
    assert.ok(root.startsWith(fixtures + sep)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
