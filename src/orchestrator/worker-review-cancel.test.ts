import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, access } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../core/task-store.js';
import { GitWorktreeManager, type WorktreeInfo, type ReviewedCommitCandidate, type WorktreeReviewSnapshot } from '../core/git-worktree.js';
import { TestRunner } from '../core/test-runner.js';
import { QuotaLimitError } from '../core/quota.js';
import { CodexAdapter } from '../adapters/codex.js';
import type { ModelBinding, RunContext } from '../adapters/types.js';
import type { HarnessAdapter, HarnessCapabilities, RunResult, TaskRecord } from '../domain/types.js';
import { TaskReviewer as RealReviewer } from './reviewer.js';
import { TaskWorker, type TaskReport, type TaskReviewer } from './worker.js';
import { createZeroServer } from '../server/server.js';

const exec = promisify(execFile);
// Real Git setup/reopening can exceed twenty seconds on concurrent Windows CI.
// Keep process startup, boundary gates and cleanup bounded by the same CI budget.
const fixtureTimeoutMs = 120_000;
const guardian = (id: string) => ({ id: id.repeat(32), lockId: 'd'.repeat(64), predecessorDrained: true, evidenceKind: 'guardian_startup_verified' as const });
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), fixtureTimeoutMs); })]); }
  finally { clearTimeout(timer!); }
}
async function fixture(run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  try { await run(f); }
  catch (error) {
    try { await f.close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Cancellation fixture and cleanup both failed'); }
    throw error;
  }
  await f.close();
}
async function createFixture() {
  const root = await mkdtemp(join(process.cwd(), '.zero-review-cancel-')); const repo = join(root, 'repo'); const db = join(root, 'tasks.sqlite'); const artifacts = join(root, 'artifacts');
  await mkdir(repo); for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) await exec('git', args, { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'seed.txt'), 'base\n'); await exec('git', ['add', '.'], { cwd: repo }); await exec('git', ['commit', '-m', 'fixture'], { cwd: repo });
  const marker = join(root, 'child.pid'); const mode = join(root, 'mode'); const childScript = join(root, 'local-review.mjs');
  await writeFile(mode, 'wait'); await writeFile(childScript, `import{readFileSync,writeFileSync}from'node:fs';if(readFileSync(${JSON.stringify(mode)},'utf8')==='wait'){writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},100);}else console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({verdict:'pass',summary:'Approved',findings:[]})}}));`);
  class LocalCodex extends CodexAdapter {
    override async probe(): Promise<HarnessCapabilities> { return { harness: 'codex', available: true, models: ['local-review'], reasoningEfforts: [], roles: ['review'] }; }
    override async prepare(context: RunContext, binding: ModelBinding) { return { ...await super.prepare(context, binding), executable: process.execPath, args: [childScript] }; }
    override async run(request: Parameters<CodexAdapter['run']>[0]) { const result = await super.run(request); if (afterChild) await afterChild(); return result; }
  }
  const codex = new LocalCodex({ timeoutMs: fixtureTimeoutMs, bindings: [{ harness: 'codex', model: { id: 'local-review', provider: 'openai', modelId: 'fixture-model' }, selector: 'cli_argument', verified: true }] });
  const realReviewer = new RealReviewer({ codex, artifactDir: artifacts, model: 'local-review', timeoutMs: fixtureTimeoutMs });
  let store = new TaskStore(db, guardian('1')); let generation = 1; let writes = 0; let reviews = 0; let routes = 0; let pending: Promise<TaskRecord | undefined> | undefined;
  const releases: Array<() => void> = [];
  let reviewBehavior: TaskReviewer['review'] | undefined;
  let afterChild: (() => Promise<void>) | undefined;
  let writerResult: RunResult | undefined;
  const reviewer: TaskReviewer = { async review(...args) { reviews++; return reviewBehavior ? reviewBehavior(...args) : realReviewer.review(...args); } };
  const writer: HarnessAdapter = { id: 'fake', async probe() { return { harness: 'fake', available: true, models: ['writer'] }; }, async run(request) { writes++; await writeFile(join(request.cwd, 'result.txt'), 'approved\n'); return writerResult ?? { status: 'completed', exitCode: 0, durationMs: 1 }; } };
  const task = store.submit({ repoPath: repo, baseRef: 'main', prompt: 'Create approved result.txt', maxRevisions: 0, allowedPaths: ['result.txt'], checks: [{ id: 'approved', argv: [process.execPath, '-e', "process.exit(require('node:fs').readFileSync('result.txt','utf8')==='approved\\n'?0:1)"] }] });
  function worker(worktrees = new GitWorktreeManager(join(root, 'worktrees'))) { return new TaskWorker({ store, worktrees, testRunner: new TestRunner({ logDirectory: join(root, 'checks') }), adapters: new Map([['fake', writer], ['codex', codex]]), artifactRoot: artifacts, reviewer,
    router: { async route(current) { routes++; return { taskId: current.id, harness: 'fake', model: 'writer', selectionSource: 'codex', reason: 'local fixture', decidedAt: new Date().toISOString() }; } }, heartbeatIntervalMs: 100 }); }
  function start(w: TaskWorker, initial = false) { if (initial) { store.claimNext('initial-owner'); pending = w.runClaimed(task.id, 'initial-owner'); } else pending = w.runNext('recovery-owner'); void pending.catch(() => undefined); return pending; }
  async function restart(verified = true) { store.close(); generation++; store = new TaskStore(db, verified ? guardian(String(generation)) : { id: String(generation).repeat(32), predecessorDrained: false, evidenceKind: 'unguarded' }); }
  async function seed(kind: 'quota' | 'guardian') {
    if (kind === 'quota') { reviewBehavior = async () => { throw new QuotaLimitError('Local review quota'); }; const paused = await start(worker(), true); assert.equal(paused?.status, 'waiting'); assert.equal(paused.resumeCheckpoint?.kind, 'review_quota'); pending = undefined;
      const sql = new DatabaseSync(db); try { sql.prepare('UPDATE quota_pauses SET retry_at=? WHERE task_id=?').run(new Date(Date.now() - 1000).toISOString(), task.id); } finally { sql.close(); }
    } else { const entered = gate(); const stopped = gate(); releases.push(stopped.release); reviewBehavior = async () => { entered.release(); await stopped.promise; throw new Error('Prior local reviewer stopped before verdict'); };
      const old = start(worker(), true); await bounded(entered.promise, 'initial review entry'); assert.deepEqual(store.recoverExpired(new Date(Date.now() + 120000)), [task.id]); stopped.release(); await old; pending = undefined; assert.equal(store.get(task.id)?.status, 'recovery_required'); }
    reviewBehavior = undefined; await restart();
  }
  async function pid() { const deadline = Date.now() + fixtureTimeoutMs; while (Date.now() < deadline) { try { await access(marker); return Number(await readFile(marker, 'utf8')); } catch {} await new Promise(r => setTimeout(r, 25)); } throw new Error('Local Codex child did not start'); }
  async function cancelHttp(w?: TaskWorker) { const server = createZeroServer({ store, config: { async read() { throw new Error('No provider'); }, async write() {} }, adapters: { codex }, ...(w ? { cancel: (id: string) => w.cancel(id) } : {}), artifactRoot: artifacts });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert.ok(address && typeof address !== 'string');
    try { const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${task.id}/cancel`, { method: 'POST' }); return { status: response.status, body: await response.json() }; }
    finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  }
  async function downloadReport() {
    const server = createZeroServer({ store, config: { async read() { throw new Error('No provider'); }, async write() {} }, adapters: { codex }, artifactRoot: artifacts });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert.ok(address && typeof address !== 'string');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${task.id}/report`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="zero-.+\.json"$/);
      return response.json() as Promise<TaskReport>;
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  }
  return { root, db, repo, artifacts, task, codex, worker, start, seed, restart, pid, cancelHttp, downloadReport,
    get store() { return store; }, get writes() { return writes; }, get reviews() { return reviews; }, get routes() { return routes; }, get generation() { return String(generation).repeat(32); },
    setReview(behavior: TaskReviewer['review'] | undefined) { reviewBehavior = behavior; }, async pass() { await writeFile(mode, 'pass'); }, addRelease(release: () => void) { releases.push(release); },
    setWriterResult(result: RunResult) { writerResult = result; },
    holdAfterChild() { const entered = gate(); const release = gate(); releases.push(release.release); afterChild = async () => { entered.release(); await release.promise; }; return { entered: entered.promise, release: release.release }; },
    async close() { releases.forEach(r => r()); for (const attempt of store.attempts(task.id).filter(a => a.role === 'review' && a.status === 'running')) await codex.cancel(task.id, attempt.id);
      if (pending) await bounded(pending.catch(() => undefined), 'fixture process cleanup'); store.close(); const actual = await realpath(root); assert.equal(dirname(actual), await realpath(process.cwd())); assert.ok(basename(actual).startsWith('.zero-review-cancel-')); await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  };
}

for (const kind of ['quota', 'guardian', 'initial'] as const) test(`${kind} review HTTP cancellation kills real local Codex and stays terminal across guardian restart`, async () => fixture(async f => {
  if (kind !== 'initial') await f.seed(kind);
  const reportPath = join(f.artifacts, f.task.id, 'report.json');
  const previousArchive = await readFile(reportPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; });
  const previousOperations = f.store.reportOperations(f.task.id);
  const worker = f.worker(); const running = f.start(worker, kind === 'initial'); const pid = await f.pid(); assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal((await f.cancelHttp(worker)).status, 202); const result = await bounded(running, 'canceled review settlement'); assert.throws(() => process.kill(pid, 0), 'the real child must be dead');
  assert.equal(result?.status, 'failed'); assert.equal(result?.failureReason, 'Cancelled by user'); assert.equal(f.store.commitOperations(f.task.id).length, 0);
  const report = await f.downloadReport();
  assert.equal(report.finalStatus, 'failed'); assert.equal(report.error, 'Cancelled by user');
  assert.deepEqual(report.task, JSON.parse(JSON.stringify(f.store.get(f.task.id))));
  assert.deepEqual(f.store.reportOperations(f.task.id), previousOperations);
  if (previousArchive) assert.deepEqual(await readFile(reportPath), previousArchive, 'existing quota/failure archive bytes remain immutable');
  else {
    const archive = JSON.parse(await readFile(reportPath, 'utf8')) as TaskReport;
    assert.equal(archive.finalStatus, 'failed'); assert.equal(archive.error, 'Cancelled by user');
    assert.equal(archive.task.status, 'failed'); assert.deepEqual(archive.attempts, JSON.parse(JSON.stringify(f.store.attempts(f.task.id))));
    assert.equal(archive.attempts.some(attempt => attempt.status === 'running'), false);
  }
  const reviews = f.reviews; assert.deepEqual(f.store.recoverExpired(new Date(Date.now() + 120000)), []); await f.restart(); await f.pass(); assert.equal(await f.worker().runNext('after-cancel'), undefined);
  assert.equal(f.store.get(f.task.id)?.status, 'failed'); assert.equal(f.reviews, reviews); assert.equal(f.writes, 1); assert.equal(f.routes, 1); assert.equal(f.store.checkRuns(f.task.id).length, 1);
}));

test('active HTTP cancellation without worker callback refuses adapter-only acknowledgement', async () => fixture(async f => {
  await f.seed('quota'); const worker = f.worker(); const running = f.start(worker); await f.pid();
  assert.equal((await f.cancelHttp()).status, 503); await worker.cancel(f.task.id); await running;
}));

test('non-cancel transient recovered review failure still recovers without writer/check replay', async () => fixture(async f => {
  await f.seed('quota'); f.setReview(async () => { throw new Error('Transient local read failure'); }); const result = await f.start(f.worker()); assert.equal(result?.status, 'reviewing');
  assert.deepEqual(f.store.recoverExpired(new Date(Date.now() + 120000)), [f.task.id]); await f.restart(); f.setReview(undefined); await f.pass();
  assert.equal((await f.worker().runNext('transient-retry'))?.status, 'done'); assert.equal(f.writes, 1); assert.equal(f.store.checkRuns(f.task.id).length, 1); assert.equal(f.store.get(f.task.id)?.revisionCount, 0);
}));

test('lease-loss cancellation race kills local child but cannot terminalize stale custody', async () => fixture(async f => {
  await f.seed('quota'); const settled = f.holdAfterChild(); const worker = f.worker(); const running = f.start(worker); const pid = await f.pid();
  assert.equal((await f.cancelHttp(worker)).status, 202);
  await bounded(settled.entered, 'child stopped before lost lease'); f.store.recoverExpired(new Date(Date.now() + 120000)); settled.release(); await running; assert.throws(() => process.kill(pid, 0));
  assert.equal(f.store.get(f.task.id)?.status, 'recovery_required'); const reviews = f.reviews;
  await f.restart(); assert.equal(await f.worker().runNext('drained-cancel'), undefined); assert.equal(f.store.get(f.task.id)?.status, 'failed'); assert.equal(f.reviews, reviews);
  assert.equal(f.store.get(f.task.id)?.recoveryReason, undefined); assert.equal(f.store.get(f.task.id)?.recoveryEvidence, undefined);
  const report = await f.downloadReport(); assert.equal(report.task.recoveryReason, undefined); assert.equal(report.task.recoveryEvidence, undefined);
  assert.equal(report.error, 'Cancelled by user');
  const cancelled = f.store.events(f.task.id).find(event => event.type === 'task.cancelled')!;
  assert.equal((cancelled.payload?.recoveryEvidence as {kind: string}).kind, 'lease_expiry');
}));

test('HTTP202 then source worker crash before cancellation catch survives through guardian without review replay', async () => fixture(async f => {
  await f.seed('quota'); const settled = f.holdAfterChild(); const worker = f.worker(); const running = f.start(worker); const pid = await f.pid();
  assert.equal((await f.cancelHttp(worker)).status, 202); await bounded(settled.entered, 'source child drained'); assert.throws(() => process.kill(pid, 0));
  const reviews = f.reviews; f.store.recoverExpired(new Date(Date.now() + 120000)); await f.restart(); settled.release(); await running.catch(() => undefined);
  assert.equal(await f.worker().runNext('after-accepted-cancel-crash'), undefined); assert.equal(f.store.get(f.task.id)?.status, 'failed'); assert.equal(f.reviews, reviews); assert.equal(f.writes, 1);
}));

test('terminal cancellation database error remains observable and guardian later consumes the durable intent', async () => fixture(async f => {
  await f.seed('quota'); const worker = f.worker(); const running = f.start(worker); await f.pid(); const sql = new DatabaseSync(f.db);
  try { sql.exec("CREATE TRIGGER reject_cancel_finish BEFORE INSERT ON events WHEN NEW.type='task.cancelled' BEGIN SELECT RAISE(ABORT,'cancel finish IO fixture'); END;");
    assert.equal((await f.cancelHttp(worker)).status, 202); await assert.rejects(running, /cancel finish IO fixture/); assert.equal(f.store.get(f.task.id)?.status, 'reviewing');
    sql.exec('DROP TRIGGER reject_cancel_finish'); f.store.recoverExpired(new Date(Date.now() + 120000)); const reviews = f.reviews; await f.restart(); assert.equal(await f.worker().runNext('after-storage-recovery'), undefined); assert.equal(f.store.get(f.task.id)?.status, 'failed'); assert.equal(f.reviews, reviews);
  } finally { sql.close(); }
}));

test('accepted cancellation persistence failure cannot return HTTP202 or stop the child', async () => fixture(async f => {
  await f.seed('quota'); const worker = f.worker(); const running = f.start(worker); const pid = await f.pid(); const sql = new DatabaseSync(f.db);
  try { sql.exec("CREATE TRIGGER reject_cancel_request BEFORE INSERT ON events WHEN NEW.type='task.cancel_requested' BEGIN SELECT RAISE(ABORT,'cancel request IO fixture'); END;");
    assert.notEqual((await f.cancelHttp(worker)).status, 202); assert.doesNotThrow(() => process.kill(pid, 0)); sql.exec('DROP TRIGGER reject_cancel_request'); await worker.cancel(f.task.id); await running;
  } finally { sql.close(); }
}));

async function seedHistory(f: Awaited<ReturnType<typeof createFixture>>, boundary: 'intent' | 'candidate' | 'applied' | 'report') {
  await f.pass(); const entered = gate(); const stopped = gate(); f.addRelease(stopped.release);
  class CrashingWorktrees extends GitWorktreeManager {
    #verifiedApplied = 0;
    override async createReviewedCommitCandidate(...args: Parameters<GitWorktreeManager['createReviewedCommitCandidate']>): Promise<ReviewedCommitCandidate> {
      if (boundary === 'intent') { entered.release(); await stopped.promise; throw new Error('Source worker drained before candidate creation'); }
      return super.createReviewedCommitCandidate(...args);
    }
    override async applyReviewedCommitCandidate(info: WorktreeInfo, candidate: ReviewedCommitCandidate, snapshot: WorktreeReviewSnapshot): Promise<string> {
      if (boundary === 'candidate') { entered.release(); await stopped.promise; throw new Error('Source worker drained before apply'); }
      const commit = await super.applyReviewedCommitCandidate(info, candidate, snapshot);
      if (boundary === 'applied') { entered.release(); await stopped.promise; throw new Error('Source worker drained after apply'); }
      return commit;
    }
    override async verifyAppliedReviewedCommitCandidate(info: WorktreeInfo, candidate: ReviewedCommitCandidate, snapshot: WorktreeReviewSnapshot): Promise<void> {
      await super.verifyAppliedReviewedCommitCandidate(info, candidate, snapshot); this.#verifiedApplied++;
      if (boundary === 'report' && this.#verifiedApplied === 2) { entered.release(); await stopped.promise; throw new Error('Source worker drained after report completion'); }
    }
  }
  const old = f.start(f.worker(new CrashingWorktrees(join(f.root, 'worktrees'))), true); await bounded(entered.promise, `seed ${boundary}`);
  assert.equal(f.store.get(f.task.id)?.status, 'reviewing'); assert.deepEqual(f.store.recoverExpired(new Date(Date.now() + 120000)), [f.task.id]); stopped.release(); await old; await f.restart();
}

for (const boundary of ['candidate', 'applied', 'report'] as const) test(`cancellation at recovered ${boundary} boundary preserves historical Git/report facts and prevents the next side effect`, async () => fixture(async f => {
  await seedHistory(f, boundary); const originalCommit = f.store.commitOperations(f.task.id)[0]!; const originalReport = f.store.reportOperations(f.task.id)[0];
  const entered = gate(); const release = gate(); f.addRelease(release.release); let held = false; let branchReads = 0;
  class BoundaryWorktrees extends GitWorktreeManager {
    async hold() { if (!held) { held = true; entered.release(); await release.promise; } }
    override async changedPaths(info: WorktreeInfo): Promise<string[]> {
      const paths = await super.changedPaths(info); const current = f.store.get(f.task.id); const operation = f.store.commitOperations(f.task.id)[0];
      if (current?.leaseOwner === 'recovery-owner' && !held &&
        (boundary === 'candidate' && operation?.status === 'candidate' || boundary === 'applied' && operation?.status === 'applied' && !f.store.reportOperations(f.task.id).length)) await this.hold();
      return paths;
    }
    override async readTaskBranchHead(info: WorktreeInfo) {
      const result = await super.readTaskBranchHead(info); if (f.store.get(f.task.id)?.leaseOwner === 'recovery-owner') {
        branchReads++; if (boundary === 'report' && branchReads === 3) await this.hold();
      } return result;
    }
  }
  const worktrees = new BoundaryWorktrees(join(f.root, 'worktrees')); const worker = f.worker(worktrees); const running = f.start(worker); await bounded(entered.promise, `recovered ${boundary} gate`);
  assert.equal((await f.cancelHttp(worker)).status, 202); release.release(); const result = await bounded(running, `settle ${boundary}`); assert.equal(result?.status, 'failed');
  const operation = f.store.commitOperations(f.task.id)[0]!; assert.equal(operation.id, originalCommit.id); assert.equal(operation.candidateSha, originalCommit.candidateSha);
  const creation = f.store.getWorktreeCreation(f.task.id)!; const info = (creation.observed as {info: WorktreeInfo}).info; const head = await worktrees.readTaskBranchHead(info);
  if (boundary === 'candidate') { assert.equal(operation.status, 'candidate'); assert.equal(head.head, operation.preHead); assert.equal(f.store.reportOperations(f.task.id).length, 0); }
  else { assert.equal(head.head, operation.candidateSha); assert.equal(operation.status, 'applied'); }
  if (boundary === 'applied') assert.equal(f.store.reportOperations(f.task.id).length, 0, 'accepted cancellation prevents preparing the next report');
  if (originalReport) { const report = f.store.reportOperations(f.task.id)[0]!; assert.equal(report.id, originalReport.id); assert.deepEqual(report.reportBytes, originalReport.reportBytes); assert.equal(report.status, 'complete'); assert.deepEqual(await readFile(report.reportPath), originalReport.reportBytes); }
  const reviews = f.reviews; await f.restart(); assert.equal(await f.worker().runNext('must-not-complete-canceled-history'), undefined); assert.equal(f.store.get(f.task.id)?.status, 'failed'); assert.equal(f.reviews, reviews);
}));

for (const failure of ['review-quota', 'writer-error'] as const) test(`HTTP cancellation accepted during ${failure} catch awaits still finalizes without restart`, async () => fixture(async f => {
  const entered = gate(); const release = gate(); f.addRelease(release.release); let held = false;
  if (failure === 'review-quota') f.setReview(async () => { throw new QuotaLimitError('quota before cancellation request'); });
  else f.setWriterResult({ status: 'failed', exitCode: 1, durationMs: 1, error: 'writer exited before cancellation request' });
  class CatchBoundaryWorktrees extends GitWorktreeManager {
    override async changedPaths(info: WorktreeInfo): Promise<string[]> {
      const paths = await super.changedPaths(info); const attempt = f.store.attempts(f.task.id).at(-1);
      if (!held && attempt && ['failed', 'interrupted'].includes(attempt.status)) { held = true; entered.release(); await release.promise; }
      return paths;
    }
  }
  const worker = f.worker(new CatchBoundaryWorktrees(join(f.root, 'worktrees'))); const running = f.start(worker, true); await bounded(entered.promise, `${failure} catch IO`);
  assert.equal((await f.cancelHttp(worker)).status, 202); release.release(); const result = await bounded(running, `${failure} cancel settlement`);
  assert.equal(result?.status, 'failed'); assert.equal(result?.failureReason, 'Cancelled by user'); assert.equal(result?.revisionCount, 0);
  const reviews = f.reviews; await f.restart(); assert.equal(await f.worker().runNext('after-late-catch-cancel'), undefined); assert.equal(f.reviews, reviews); assert.equal(f.writes, 1);
}));

test('recovered intent cancellation during awaited changedPaths must not create a new Git candidate', async () => fixture(async f => {
  await seedHistory(f, 'intent'); const entered = gate(); const release = gate(); f.addRelease(release.release); let held = false; let created = 0;
  class IntentBoundaryWorktrees extends GitWorktreeManager {
    override async changedPaths(info: WorktreeInfo): Promise<string[]> {
      const paths = await super.changedPaths(info);
      if (!held && f.store.get(f.task.id)?.leaseOwner === 'recovery-owner' && f.store.commitOperations(f.task.id)[0]?.status === 'intent') { held = true; entered.release(); await release.promise; }
      return paths;
    }
    override async createReviewedCommitCandidate(...args: Parameters<GitWorktreeManager['createReviewedCommitCandidate']>) { created++; return super.createReviewedCommitCandidate(...args); }
  }
  const worker = f.worker(new IntentBoundaryWorktrees(join(f.root, 'worktrees'))); const running = f.start(worker); await bounded(entered.promise, 'intent candidate await');
  assert.equal((await f.cancelHttp(worker)).status, 202); release.release(); assert.equal((await running)?.status, 'failed');
  assert.equal(created, 0, 'no new candidate operation may begin after cancellation was accepted'); assert.equal(f.store.commitOperations(f.task.id)[0]?.status, 'intent');
  assert.equal(f.store.commitOperations(f.task.id)[0]?.candidateSha, undefined); assert.equal(f.store.reportOperations(f.task.id).length, 0);
}));

for (const first of ['cancellation', 'DONE'] as const) test(`independent SQLite connections serialize ${first} before the competing terminal action`, async () => fixture(async f => {
  await f.pass();
  let peer: TaskStore | undefined; let entered = false; let archive: Buffer | undefined;
  f.store.completeReviewedTask = input => {
    entered = true; peer = new TaskStore(f.db);
    const operation = f.store.getReportOperation(input.reportOperationId)!;
    assert.equal(operation.status, 'complete'); archive = Buffer.from(operation.reportBytes);
    if (first === 'cancellation') {
      f.store.requestTaskCancellation(f.task.id, input.owner, input.generationId);
      assert.throws(() => peer!.completeReviewedTask(input), error => error instanceof Error && error.name === 'TaskCancellationConflictError');
      throw new Error('Cancellation won the terminal transaction ordering');
    }
    const done = peer.completeReviewedTask(input);
    assert.equal(done.status, 'done');
    assert.throws(() => f.store.requestTaskCancellation(f.task.id, input.owner, input.generationId), error => error instanceof Error && error.name === 'TaskCancellationConflictError');
    return done;
  };
  try {
    const result = await f.start(f.worker(), true); assert.equal(entered, true);
    assert.equal(result?.status, first === 'cancellation' ? 'failed' : 'done');
    assert.equal(Boolean(f.store.getTaskCancellation(f.task.id)), first === 'cancellation');
    const operation = f.store.reportOperations(f.task.id)[0]!;
    assert.equal(operation.status, 'complete'); assert.deepEqual(await readFile(operation.reportPath), archive);
    const events = f.store.events(f.task.id);
    assert.equal(events.filter(event => event.type === 'task.transition' && event.payload?.to === 'done').length, first === 'DONE' ? 1 : 0);
    assert.equal(events.filter(event => event.type === 'task.cancel_requested').length, first === 'cancellation' ? 1 : 0);
  } finally { peer?.close(); }
}));

test('late cancellation before failed worktree creation quarantine settles in the same worker run', async () => fixture(async f => {
  class FailedCreationWorktrees extends GitWorktreeManager {
    override async executePlan(..._args: Parameters<GitWorktreeManager['executePlan']>): ReturnType<GitWorktreeManager['executePlan']> { throw new Error('Local creation failed'); }
  }
  const original = f.store.requireWorktreeRecovery.bind(f.store);
  f.store.requireWorktreeRecovery = (...args) => {
    f.store.requestTaskCancellation(f.task.id, 'initial-owner', f.generation);
    return original(...args);
  };
  const result = await f.start(f.worker(new FailedCreationWorktrees(join(f.root, 'worktrees'))), true);
  assert.equal(result?.status, 'failed'); assert.equal(result?.failureReason, 'Cancelled by user');
  assert.equal(f.store.getWorktreeCreation(f.task.id)?.status, 'intent');
  assert.equal(f.routes, 0); assert.equal(f.writes, 0); assert.equal(f.reviews, 0);
  assert.equal((await f.downloadReport()).error, 'Cancelled by user');
}));

test('HTTP cancellation during claimed execution recovery inspection beats later quarantine without restart', async () => fixture(async f => {
  const entered = gate(); const release = gate(); f.addRelease(release.release);
  class FailedReopeningWorktrees extends GitWorktreeManager {
    override async reopenFromEvidence(..._args: Parameters<GitWorktreeManager['reopenFromEvidence']>): ReturnType<GitWorktreeManager['reopenFromEvidence']> {
      entered.release(); await release.promise; throw new Error('Local recovery inspection failed after cancellation');
    }
  }
  const worktrees = new FailedReopeningWorktrees(join(f.root, 'worktrees'));
  assert.equal(f.store.claimNext('source-owner')?.id, f.task.id);
  const plan = await worktrees.prepareCreatePlan(f.task.id, f.repo, 'main');
  f.store.recordWorktreeCreationIntent(f.task.id, 'source-owner', plan);
  const observed = await worktrees.executePlan(plan); f.store.completeWorktreeCreation(f.task.id, 'source-owner', observed, observed.fingerprint);
  f.store.recoverExpired(new Date(Date.now() + 120000)); await f.restart();
  assert.ok(f.store.claimExecutionRecovery(f.task.id, 'recovery-owner', { identity: { checkedAt: new Date().toISOString(), observed, fingerprint: observed.fingerprint } }));
  const worker = f.worker(worktrees); const running = worker.runClaimed(f.task.id, 'recovery-owner');
  try {
    await bounded(entered.promise, 'execution recovery inspection');
    assert.equal((await f.cancelHttp(worker)).status, 202); release.release();
    const result = await bounded(running, 'cancellation beats inspection quarantine');
    assert.equal(result.status, 'failed'); assert.equal(result.failureReason, 'Cancelled by user');
    assert.equal(result.recoveryReason, undefined); assert.equal(result.recoveryEvidence, undefined);
    assert.equal(f.routes, 0); assert.equal(f.writes, 0); assert.equal(f.reviews, 0);
    assert.equal((await f.downloadReport()).error, 'Cancelled by user');
    assert.equal(f.store.executionRecoveryCheckpoint(f.task.id), undefined);
    const sql = new DatabaseSync(f.db);
    try { assert.equal((sql.prepare('SELECT status FROM execution_recovery_checkpoints WHERE task_id=?').get(f.task.id) as {status: string}).status, 'disabled'); }
    finally { sql.close(); }
    await f.restart(); assert.equal(await f.worker().runNext('must-not-replay-quarantine'), undefined);
  } finally { release.release(); await running.catch(() => undefined); }
}));
