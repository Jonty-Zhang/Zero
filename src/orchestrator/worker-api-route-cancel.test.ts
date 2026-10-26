import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessAdapter } from '../domain/types.js';
import { TaskStore } from '../core/task-store.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TestRunner } from '../core/test-runner.js';
import { OpenAICompatibleCoordinator } from './openai-compatible-coordinator.js';
import { TaskRouter } from './router.js';
import { TaskWorker } from './worker.js';

const exec = promisify(execFile);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 60_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

for (const stop of ['user', 'lease'] as const) {
  test(`${stop} cancellation stops the actual API router and never starts a writer`, async context => {
    const root = await mkdtemp(join(process.cwd(), '.zero-api-route-cancel-'));
    const repo = join(root, 'repo');
    const store = new TaskStore();
    const entered = gate();
    const aborted = gate();
    let release = () => {};
    let running: ReturnType<TaskWorker['runNext']> | undefined;
    let codexCancels = 0;
    let writers = 0;
    const oldKey = process.env.ZERO_WORKER_API_CANCEL_FIXTURE_KEY;
    process.env.ZERO_WORKER_API_CANCEL_FIXTURE_KEY = 'local-fixture-only';
    try {
      await mkdir(repo);
      for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) {
        await exec('git', args, { cwd: repo, windowsHide: true });
      }
      await writeFile(join(repo, 'seed.txt'), 'base\n');
      await exec('git', ['add', '.'], { cwd: repo, windowsHide: true });
      await exec('git', ['commit', '-m', 'fixture'], { cwd: repo, windowsHide: true });
      const task = store.submit({ repoPath: repo, baseRef: 'main', prompt: 'Cancel during API allocation',
        checks: [{ id: 'never-run', argv: [process.execPath, '-e', 'process.exit(0)'] }], maxRevisions: 0 });
      const api = new OpenAICompatibleCoordinator({ baseUrl: 'https://fixture.invalid/v1', model: 'router',
        keyEnv: 'ZERO_WORKER_API_CANCEL_FIXTURE_KEY', timeoutMs: 30_000,
        fetch: async (_url, init) => new Promise<Response>((resolve, reject) => {
          const signal = init!.signal!;
          const onAbort = () => { aborted.release(); reject(signal.reason); };
          signal.addEventListener('abort', onAbort, { once: true });
          release = () => {
            signal.removeEventListener('abort', onAbort);
            resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ taskType: 'implementation',
              complexity: 'low', bindingId: 'fake:writer', reasoningEffort: null, reason: 'fixture' }) } }] }));
          };
          entered.release();
        }) });
      const codex: HarnessAdapter = { id: 'codex', async probe() { throw new Error('Unused Codex'); },
        async run() { throw new Error('Unused Codex'); }, async cancel() { codexCancels++; } };
      const writer: HarnessAdapter = { id: 'fake', async probe() { return { harness: 'fake', available: true, models: ['writer'] }; },
        async run() { writers++; throw new Error('Cancelled route must not launch a writer'); } };
      const router = new TaskRouter({ codex, api, coordinatorKind: 'api', coordinatorModel: 'router', cwd: repo,
        artifactDir: join(root, 'route-artifacts'), getCandidates: () => [{ bindingId: 'fake:writer', harness: 'fake',
          model: 'writer', verified: true, available: true, healthy: true, reasoningEfforts: [], capabilities: ['code'] }] });
      const worker = new TaskWorker({ store, worktrees: new GitWorktreeManager(join(root, 'worktrees')),
        testRunner: new TestRunner(), artifactRoot: join(root, 'artifacts'), router,
        adapters: new Map([['codex', codex], ['fake', writer]]), leaseMs: 60_000, heartbeatIntervalMs: 10,
        reviewer: { async review() { throw new Error('Cancelled route must not reach review'); } } });
      if (stop === 'lease') context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      running = worker.runNext('api-route-worker');
      await bounded(Promise.race([entered.promise, running.then(result => {
        throw new Error(`Worker finished before API entry: ${JSON.stringify(result)}`);
      })]), 'API entry');
      if (stop === 'user') assert.equal(await worker.cancel(task.id), true);
      else context.mock.timers.setTime(Date.parse(store.get(task.id)!.leaseExpiresAt!) + 1);
      // Git setup/settlement has its own budget; abort responsiveness stays strict.
      await bounded(aborted.promise, 'API request abort', 3_000);
      const result = await bounded(running, 'worker settlement');
      assert.equal(codexCancels, 0, 'cancellation must target the selected API, not an unrelated Codex adapter');
      assert.equal(writers, 0);
      const attempt = store.attempts(task.id).at(-1)!;
      assert.equal(attempt.role, 'route');
      assert.equal(attempt.harness, 'api-coordinator');
      assert.equal(attempt.model, 'router');
      assert.equal(attempt.status, 'interrupted');
      if (stop === 'user') {
        assert.equal(result?.status, 'failed');
        assert.equal(result.failureReason, 'Cancelled by user');
      } else {
        assert.deepEqual(store.recoverExpired(), [task.id]);
        assert.equal(store.get(task.id)?.status, 'recovery_required');
      }
      assert.deepEqual(store.stages(task.id), []);
      assert.deepEqual(store.checks(task.id), []);
      assert.deepEqual(store.commitOperations(task.id), []);
    } finally {
      release();
      context.mock.timers.reset();
      try { if (running) await bounded(running, 'fixture cleanup'); }
      finally {
        store.close();
        if (oldKey === undefined) delete process.env.ZERO_WORKER_API_CANCEL_FIXTURE_KEY;
        else process.env.ZERO_WORKER_API_CANCEL_FIXTURE_KEY = oldKey;
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  });
}
