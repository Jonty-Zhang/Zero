import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessAdapter, HarnessCapabilities, RouteDecision, RunRequest, RunResult, TaskRecord } from "../domain/types.js";
import { GitWorktreeManager, type WorktreeInfo, type WorktreeReviewSnapshot } from "../core/git-worktree.js";
import { TaskStore } from "../core/task-store.js";
import { TestRunner } from "../core/test-runner.js";
import { QuotaLimitError } from "../core/quota.js";
import { HANDOFF_V1_MAX_BYTES } from "../domain/handoff.js";
import { TaskWorker, type TaskReviewer, type TaskRouter } from "./worker.js";

const exec = promisify(execFile);

class FakeAdapter implements HarnessAdapter {
  readonly id = "fake";
  async probe(): Promise<HarnessCapabilities> { return { harness: this.id, available: true, models: ["model"], roles: ["implement", "revise"], reasoningEfforts: [] }; }
  async run(request: RunRequest): Promise<RunResult> {
    await writeFile(join(request.cwd, "result.txt"), "approved\n");
    return { status: "completed", exitCode: 0, requestedModel: request.model, actualModel: request.model, durationMs: 1 };
  }
}

function routeFor(task: TaskRecord): RouteDecision {
  return {
    taskId: task.id, harness: "fake", model: "model", selectionSource: "codex",
    fieldSources: { harness: "codex", model: "codex", reasoningEffort: "codex" },
    reason: "Test route", decidedAt: new Date().toISOString(),
  };
}

test("worker runs checks, reviewer revision, commits, archives and marks DONE", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-test-"));
  const repo = join(root, "repo");
  const artifacts = join(root, "artifacts");
  const store = new TaskStore();
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });

    const task = store.submit({
      repoPath: repo, baseRef: "main", prompt: "Create the approved result file", acceptanceCriteria: ["result.txt contains approved content"], maxRevisions: 1,
      checks: [{ id: "result-check", argv: [process.execPath, "-e", "process.exit(require('fs').readFileSync('result.txt','utf8').includes('approved') ? 0 : 1)"] }],
    });
    const owner = "worker-test";
    assert.equal(store.claimNext(owner)?.id, task.id);
    let reviewCount = 0;
    const router: TaskRouter = { async route(current) { return routeFor(current); } };
    const reviewer: TaskReviewer = {
      async review() {
        reviewCount++;
        return {
          harness: "codex", model: "review-model", exitCode: 0,
          result: reviewCount === 1
            ? { verdict: "changes_requested", summary: "Add a newline invariant.", findings: [{ severity: "low", evidence: "The file has no final newline.", requestedChange: "Keep a final newline." }] }
            : { verdict: "pass", summary: "Checks and acceptance criteria pass.", findings: [] },
        };
      },
    };
    const worker = new TaskWorker({
      store, worktrees: new GitWorktreeManager(join(root, "worktrees")),
      testRunner: new TestRunner({ logDirectory: join(artifacts, "checks") }),
      router, reviewer, adapters: new Map([["fake", new FakeAdapter()]]), artifactRoot: artifacts,
    });
    const done = await worker.runClaimed(task.id, owner);
    assert.equal(done.status, "done");
    assert.equal(done.revisionCount, 1);
    assert.equal(reviewCount, 2);
    const attempts = store.attempts(task.id);
    assert.equal(attempts.filter(attempt => attempt.role === "revise").length, 1);
    assert.equal(attempts.find(attempt => attempt.role === "review")?.model, "review-model");
    assert.equal(store.checks(task.id).length, 2);
    const executionStages = store.stages(task.id);
    assert.deepEqual(executionStages.map(item => item.role), ["implement", "revise"]);
    assert.deepEqual(executionStages.map(item => item.status), ["succeeded", "succeeded"]);
    assert.notEqual(executionStages[0]?.processStartId, executionStages[1]?.processStartId);
    assert.equal(executionStages[1]?.predecessorStageId, executionStages[0]?.id);
    assert.equal(store.handoffs(task.id).length, 2);
    const report = await worker.readReport(task.id);
    assert.equal(report?.finalStatus, "done");
    assert.ok(report?.resultCommit);
    assert.ok(report?.diffPath);
    assert.equal(report?.stages?.length, 2);
    assert.equal(report?.handoffs?.length, 2);
    assert.match(report?.handoffs?.[0]?.workspace.fingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.equal(report?.handoffs?.[0]?.task.objective, task.prompt);
    assert.deepEqual(report?.handoffs?.[0]?.task.acceptanceCriteria, task.acceptanceCriteria);
    assert.match(await (await import("node:fs/promises")).readFile(report!.diffPath!, "utf8"), /result\.txt/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker refuses a late allowed-path edit injected after review checks and before commit", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-reviewed-tree-race-test-"));
  const repo = join(root, "repo");
  const artifacts = join(root, "artifacts");
  const worktreeRoot = join(root, "worktrees");
  const store = new TaskStore();
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const { stdout: baseOutput } = await exec("git", ["rev-parse", "HEAD"], { cwd: repo });
    const baseCommit = baseOutput.trim();

    class LateEditWorktrees extends GitWorktreeManager {
      override async commit(info: WorktreeInfo, message: string, reviewed: WorktreeReviewSnapshot): Promise<string | undefined> {
        // This runs only after Worker has completed its post-review fingerprint check.
        await writeFile(join(info.path, "result.txt"), "late unreviewed edit\n");
        return super.commit(info, message, reviewed);
      }
    }

    const task = store.submit({
      repoPath: repo,
      baseRef: "main",
      prompt: "Create the approved result file",
      acceptanceCriteria: ["result.txt contains approved content"],
      maxRevisions: 0,
      checks: [{ id: "result-check", argv: [process.execPath, "-e", "process.exit(require('fs').readFileSync('result.txt','utf8') === 'approved\\n' ? 0 : 1)"] }],
    });
    const owner = "worker-review-race";
    assert.equal(store.claimNext(owner)?.id, task.id);
    const reviewer: TaskReviewer = {
      async review() {
        return { harness: "codex", model: "review", exitCode: 0,
          result: { verdict: "pass", summary: "Approved", findings: [] } };
      },
    };
    const worker = new TaskWorker({
      store,
      worktrees: new LateEditWorktrees(worktreeRoot),
      testRunner: new TestRunner({ logDirectory: join(artifacts, "checks") }),
      router: { async route(current) { return routeFor(current); } },
      reviewer,
      adapters: new Map([["fake", new FakeAdapter()]]),
      artifactRoot: artifacts,
    });

    const failed = await worker.runClaimed(task.id, owner);
    assert.equal(failed.status, "failed");
    assert.match(failed.failureReason ?? "", /unstaged tracked changes|no longer matches the reviewed snapshot before commit/);
    const worktreePath = join(worktreeRoot, task.id);
    const { stdout: headOutput } = await exec("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    assert.equal(headOutput.trim(), baseCommit);
    assert.equal(await (await import("node:fs/promises")).readFile(join(worktreePath, "result.txt"), "utf8"), "late unreviewed edit\n");
    assert.equal(store.reviews(task.id)[0]?.verdict, "pass");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker cannot mark DONE when checks fail and revision budget is exhausted", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-test-"));
  const repo = join(root, "repo");
  const store = new TaskStore();
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: "Make output", maxRevisions: 0,
      checks: [{ id: "always-fail", argv: [process.execPath, "-e", "process.exit(7)"] }] });
    const owner = "worker-fail";
    store.claimNext(owner);
    const worker = new TaskWorker({
      store, worktrees: new GitWorktreeManager(join(root, "worktrees")), testRunner: new TestRunner(),
      router: { async route(current) { return routeFor(current); } },
      reviewer: { async review() { throw new Error("review must not run after a red check"); } },
      adapters: new Map([["fake", new FakeAdapter()]]), artifactRoot: join(root, "artifacts"),
    });
    const failed = await worker.runClaimed(task.id, owner);
    assert.equal(failed.status, "failed");
    assert.match(failed.failureReason ?? "", /Validation failed/);
    assert.equal(store.reviews(task.id).length, 0);
    assert.equal(store.stages(task.id)[0]?.status, "failed");
    assert.equal(store.handoffs(task.id)[0]?.checks[0]?.status, "failed");
    assert.equal((await worker.readReport(task.id))?.finalStatus, "failed");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker refuses DONE when Harness creates only an empty commit", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-empty-test-"));
  const repo = join(root, "repo");
  const store = new TaskStore();
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: "Make a change", checks: [{ id: "ok", argv: [process.execPath, "-e", "process.exit(0)"] }] });
    const owner = "worker-empty";
    store.claimNext(owner);
    const emptyCommitAdapter: HarnessAdapter = {
      id: "fake",
      async probe() { return { harness: "fake", available: true, models: ["model"], roles: ["implement"] }; },
      async run(request: RunRequest) {
        await exec("git", ["-c", "user.name=Harness", "-c", "user.email=harness@example.com", "commit", "--allow-empty", "-m", "empty"], { cwd: request.cwd });
        return { status: "completed", exitCode: 0, requestedModel: request.model, actualModel: request.model, durationMs: 1 };
      },
    };
    const worker = new TaskWorker({
      store, worktrees: new GitWorktreeManager(join(root, "worktrees")), testRunner: new TestRunner(),
      router: { async route(current) { return routeFor(current); } },
      reviewer: { async review() { return { harness: "codex", model: "review", exitCode: 0, result: { verdict: "pass", summary: "pass", findings: [] } }; } },
      adapters: new Map([["fake", emptyCommitAdapter]]), artifactRoot: join(root, "artifacts"),
    });
    const result = await worker.runClaimed(task.id, owner);
    assert.equal(result.status, "failed");
    assert.match(result.failureReason ?? "", /no-op task DONE/);
    assert.notEqual((await worker.readReport(task.id))?.finalStatus, "done");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("worker cancels a running validation process and cannot mark DONE", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-cancel-test-"));
  const repo = join(root, "repo");
  const store = new TaskStore();
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const marker = join(root, "check-started");
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: "Make output", checks: [{ id: "long-check", argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'started'); setTimeout(()=>process.exit(0),30000)`] }] });
    const owner = "worker-cancel";
    store.claimNext(owner);
    let reviewed = false;
    const worker = new TaskWorker({
      store, worktrees: new GitWorktreeManager(join(root, "worktrees")), testRunner: new TestRunner(),
      router: { async route(current) { return routeFor(current); } },
      reviewer: { async review() { reviewed = true; return { harness: "codex", model: "review", exitCode: 0, result: { verdict: "pass", summary: "pass", findings: [] } }; } },
      adapters: new Map([["fake", new FakeAdapter()]]), artifactRoot: join(root, "artifacts"),
    });
    const running = worker.runClaimed(task.id, owner);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { await import("node:fs/promises").then(fs => fs.access(marker)); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    await import("node:fs/promises").then(fs => fs.access(marker));
    assert.equal(await worker.cancel(task.id), true);
    const result = await running;
    assert.equal(result.status, "failed");
    assert.match(result.failureReason ?? "", /Cancelled by user/);
    assert.equal(reviewed, false);
    assert.equal((await worker.readReport(task.id))?.finalStatus, "failed");
    assert.equal(store.stages(task.id)[0]?.status, "interrupted");
    assert.equal(store.handoffs(task.id)[0]?.source.attemptId, store.attempts(task.id).find(item => item.stageId)?.id);
    assert.match(store.handoffs(task.id)[0]?.currentState ?? "", /stage was cancelled/);
    assert.ok(store.events(task.id).some(event => event.type === "task.transition" && event.payload?.reason === "Cancelled by user"));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("worker rechecks changed paths after test commands and rejects test-created files", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-test-"));
  const repo = join(root, "repo");
  const store = new TaskStore();
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: "write in range", maxRevisions: 0, allowedPaths: ["result.txt"],
      checks: [{ id: "writes-outside-allowlist", argv: [process.execPath, "-e", "require('fs').writeFileSync('rogue.txt','generated')"] }] });
    const owner = "worker-allowlist";
    store.claimNext(owner);
    let reviewed = false;
    const worker = new TaskWorker({
      store, worktrees: new GitWorktreeManager(join(root, "worktrees")), testRunner: new TestRunner(),
      router: { async route(current) { return routeFor(current); } },
      reviewer: { async review() { reviewed = true; return { harness: "codex", model: "review", exitCode: 0, result: { verdict: "pass", summary: "pass", findings: [] } }; } },
      adapters: new Map([["fake", new FakeAdapter()]]), artifactRoot: join(root, "artifacts"),
    });
    const failed = await worker.runClaimed(task.id, owner);
    assert.equal(failed.status, "failed");
    assert.match(failed.failureReason ?? "", /outside allowedPaths/);
    assert.equal(reviewed, false);
    assert.equal(store.reviews(task.id).length, 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker refuses to reuse an existing worktree after lease recovery", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-test-"));
  const repo = join(root, "repo");
  const store = new TaskStore();
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: "recover safely", checks: [{ id: "ok", argv: [process.execPath, "-e", "process.exit(0)"] }] });
    const owner = "old-worker";
    store.claimNext(owner, 1000, new Date("2026-01-01T00:00:00Z"));
    const worktrees = new GitWorktreeManager(join(root, "worktrees"));
    await worktrees.create(task.id, repo, "main");
    store.recoverExpired(new Date("2026-01-01T00:00:02Z"));
    store.claimNext("new-worker");
    let routed = false;
    const worker = new TaskWorker({
      store, worktrees, testRunner: new TestRunner(),
      router: { async route(current) { routed = true; return routeFor(current); } },
      reviewer: { async review() { throw new Error("must not review"); } },
      adapters: new Map([["fake", new FakeAdapter()]]), artifactRoot: join(root, "artifacts"),
    });
    const recovered = await worker.runClaimed(task.id, "new-worker");
    assert.equal(recovered.status, "failed");
    assert.match(recovered.failureReason ?? "", /existing task worktree requires recovery inspection/);
    assert.equal(routed, false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("quota pause survives service restart and resumes partial work without consuming a revision", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-quota-test-"));
  const repo = join(root, "repo");
  const db = join(root, "tasks.sqlite");
  await mkdir(repo);
  let store = new TaskStore(db);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: "Complete result.txt", maxRevisions: 0,
      checks: [{ id: "result", argv: [process.execPath, "-e", "process.exit(require('fs').readFileSync('result.txt','utf8') === 'approved\\n' ? 0 : 1)"] }] });
    let routes = 0;
    let executions = 0;
    const router: TaskRouter = { async route(current) { routes++; return routeFor(current); } };
    const adapter: HarnessAdapter = {
      id: "fake",
      async probe() { return { harness: "fake", available: true, models: ["model"] }; },
      async run(request) {
        executions++;
        if (executions === 1) {
          await writeFile(join(request.cwd, "result.txt"), "partial\n");
          return { status: "failed", exitCode: 1, durationMs: 1, quota: { source: "provider_message", retryAt: new Date(Date.now() + 60_000).toISOString() } };
        }
        assert.match(request.prompt, /Continue in this same worktree/);
        assert.equal(await (await import("node:fs/promises")).readFile(join(request.cwd, "result.txt"), "utf8"), "partial\n");
        await writeFile(join(request.cwd, "result.txt"), "approved\n");
        return { status: "completed", exitCode: 0, durationMs: 1 };
      },
    };
    const reviewer: TaskReviewer = { async review() { return { harness: "codex", model: "review", exitCode: 0,
      result: { verdict: "pass", summary: "approved", findings: [] } }; } };
    const createWorker = () => new TaskWorker({ store, worktrees: new GitWorktreeManager(join(root, "worktrees")),
      testRunner: new TestRunner(), router, reviewer, adapters: new Map([["fake", adapter]]), artifactRoot: join(root, "artifacts") });
    const firstOwner = "quota-worker-1";
    assert.equal(store.claimNext(firstOwner)?.id, task.id);
    const waiting = await createWorker().runClaimed(task.id, firstOwner);
    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.revisionCount, 0);
    assert.equal(waiting.resumeStage, "execute");
    assert.equal(store.stages(task.id)[0]?.status, "interrupted");
    assert.equal(store.handoffs(task.id)[0]?.workspace.fingerprint?.length, 64);
    assert.ok(waiting.retryAt);
    assert.equal(store.claimNext("early"), undefined);
    store.close();
    store = new TaskStore(db);
    const secondOwner = "quota-worker-2";
    assert.equal(store.claimNext(secondOwner, 60_000, new Date(Date.parse(waiting.retryAt!) + 1000))?.id, task.id);
    const done = await createWorker().runClaimed(task.id, secondOwner);
    assert.equal(done.status, "done");
    assert.equal(done.revisionCount, 0);
    assert.equal(routes, 1);
    assert.equal(executions, 2);
    const stages = store.stages(task.id);
    assert.equal(stages.length, 2);
    assert.deepEqual(stages.map(item => item.status), ["interrupted", "succeeded"]);
    assert.equal(stages[1]?.predecessorStageId, stages[0]?.id);
    assert.equal(new Set(stages.map(item => item.processStartId)).size, 2);
    assert.equal(store.handoffs(task.id).length, 2);
    const archive = await createWorker().readReport(task.id);
    assert.equal(archive?.stages?.length, 2);
    assert.equal(archive?.handoffs?.length, 2);
    assert.equal((await createWorker().readReport(task.id))?.finalStatus, "done");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("quota resume fails closed when the archived stage fingerprint differs from the checkpoint", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-quota-fingerprint-test-"));
  const repo = join(root, "repo");
  const store = new TaskStore();
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: "Complete the task", maxRevisions: 0,
      checks: [{ id: "smoke", argv: [process.execPath, "-e", "process.exit(0)"] }] });
    const manager = new GitWorktreeManager(join(root, "worktrees"));
    const fingerprint = manager.fingerprint.bind(manager);
    let fingerprintCalls = 0;
    manager.fingerprint = async info => {
      const value = await fingerprint(info);
      fingerprintCalls++;
      return fingerprintCalls === 3 ? "0".repeat(64) : value;
    };
    const adapter: HarnessAdapter = {
      id: "fake",
      async probe() { return { harness: "fake", available: true, models: ["model"] }; },
      async run() { return { status: "failed", exitCode: 1, durationMs: 1,
        quota: { source: "provider_message", retryAt: new Date(Date.now() + 60_000).toISOString() } }; },
    };
    store.claimNext("fingerprint-worker");
    const worker = new TaskWorker({ store, worktrees: manager, testRunner: new TestRunner(),
      router: { async route(current) { return routeFor(current); } },
      reviewer: { async review() { throw new Error("must not review"); } },
      adapters: new Map([["fake", adapter]]), artifactRoot: join(root, "artifacts") });
    const result = await worker.runClaimed(task.id, "fingerprint-worker");
    assert.equal(result.status, "failed");
    assert.match(result.failureReason ?? "", /Worktree changed after the interrupted execution stage was archived/);
    assert.equal(store.stages(task.id)[0]?.status, "interrupted");
    assert.equal(store.stages(task.id)[0]?.outputFingerprint?.length, 64);
    assert.equal(result.resumeCheckpoint, undefined);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("oversized handoff falls back to the task record and stays within 64 KiB", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-handoff-size-test-"));
  const repo = join(root, "repo");
  const store = new TaskStore();
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const task = store.submit({
      repoPath: repo,
      baseRef: "main",
      prompt: "目标".repeat(9_000),
      acceptanceCriteria: Array.from({ length: 20 }, () => "验收".repeat(500)),
      checks: Array.from({ length: 40 }, (_, index) => ({
        id: `check-${index}-界`.padEnd(160, "界"),
        argv: [process.execPath, "-e", "process.exit(0)"],
      })),
    });
    store.claimNext("handoff-size-worker");
    const worker = new TaskWorker({
      store,
      worktrees: new GitWorktreeManager(join(root, "worktrees")),
      testRunner: new TestRunner(),
      router: { async route(current) { return routeFor(current); } },
      reviewer: { async review() { return { harness: "codex", model: "review", exitCode: 0,
        result: { verdict: "pass", summary: "pass", findings: [] } }; } },
      adapters: new Map([["fake", new FakeAdapter()]]),
      artifactRoot: join(root, "artifacts"),
    });

    const result = await worker.runClaimed(task.id, "handoff-size-worker");
    assert.equal(result.status, "done");
    const handoff = store.handoffs(task.id)[0]!;
    assert.ok(Buffer.byteLength(JSON.stringify(handoff), "utf8") <= HANDOFF_V1_MAX_BYTES);
    assert.match(handoff.task.objective, /original task objective is omitted.*primary Zero task record/s);
    assert.equal(handoff.task.acceptanceCriteria.length, 1);
    assert.match(handoff.task.acceptanceCriteria[0]!, /Full acceptance criteria are retained.*primary task record/);
    assert.equal(handoff.workspace.state, "dirty");
    assert.match(handoff.workspace.fingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.equal(store.stages(task.id)[0]?.status, "succeeded");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex allocation and review quota pauses resume at their exact stages", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-quota-stage-test-"));
  const repo = join(root, "repo");
  const db = join(root, "tasks.sqlite");
  await mkdir(repo);
  let store = new TaskStore(db);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: "Write result", maxRevisions: 0,
      checks: [{ id: "result", argv: [process.execPath, "-e", "process.exit(require('fs').readFileSync('result.txt','utf8').includes('approved') ? 0 : 1)"] }] });
    let routeCalls = 0;
    let runCalls = 0;
    let reviewCalls = 0;
    const retry = () => new Date(Date.now() + 60_000).toISOString();
    const router: TaskRouter = { async route(current) {
      routeCalls++;
      if (routeCalls === 1) throw new QuotaLimitError("Codex allocation usage limit", retry());
      return routeFor(current);
    } };
    const adapter: HarnessAdapter = { id: "fake", async probe() { return { harness: "fake", available: true, models: ["model"] }; },
      async run(request) { runCalls++; await writeFile(join(request.cwd, "result.txt"), "approved\n");
        return { status: "completed", exitCode: 0, durationMs: 1 }; } };
    const reviewer: TaskReviewer = { async review() { reviewCalls++;
      if (reviewCalls === 1) throw new QuotaLimitError("Codex review usage limit", retry());
      return { harness: "codex", model: "review", exitCode: 0, result: { verdict: "pass", summary: "pass", findings: [] } };
    } };
    const worker = () => new TaskWorker({ store, worktrees: new GitWorktreeManager(join(root, "worktrees")),
      testRunner: new TestRunner(), router, reviewer, adapters: new Map([["fake", adapter]]), artifactRoot: join(root, "artifacts") });
    for (let cycle = 0; cycle < 3; cycle++) {
      const current = store.get(task.id)!;
      const now = current.retryAt ? new Date(Date.parse(current.retryAt) + 1000) : new Date();
      const owner = `quota-stage-${cycle}`;
      assert.equal(store.claimNext(owner, 60_000, now)?.id, task.id);
      const result = await worker().runClaimed(task.id, owner);
      if (cycle < 2) {
        assert.equal(result.status, "waiting");
        assert.equal(result.resumeStage, cycle === 0 ? "route" : "review");
        assert.equal(result.revisionCount, 0);
        store.close();
        store = new TaskStore(db);
      } else assert.equal(result.status, "done");
    }
    assert.equal(routeCalls, 2);
    assert.equal(runCalls, 1);
    assert.equal(reviewCalls, 2);
    assert.equal(store.stages(task.id).length, 1);
    assert.equal(store.stages(task.id)[0]?.status, "succeeded");
    assert.equal(store.handoffs(task.id).length, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("failed validation stage is handed off before a linked revision stage starts", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-stage-revision-test-"));
  const repo = join(root, "repo");
  const store = new TaskStore();
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: `Write an approved result. ${"Objective detail ".repeat(600)}`,
      acceptanceCriteria: Array.from({ length: 22 }, (_, index) => `Criterion ${index + 1}: ${"detailed requirement ".repeat(100)}`), maxRevisions: 1,
      checks: [{ id: "approved-result", argv: [process.execPath, "-e", "process.exit(require('fs').readFileSync('result.txt','utf8') === 'approved\\n' ? 0 : 1)"] }] });
    store.claimNext("stage-revision-worker");
    let runs = 0;
    const adapter: HarnessAdapter = { id: "fake", async probe() { return { harness: "fake", available: true, models: ["model"] }; },
      async run(request) { runs++; await writeFile(join(request.cwd, "result.txt"), runs === 1 ? "needs revision\n" : "approved\n");
        return { status: "completed", exitCode: 0, durationMs: 1 }; } };
    const worker = new TaskWorker({ store, worktrees: new GitWorktreeManager(join(root, "worktrees")), testRunner: new TestRunner(),
      router: { async route(current) { return routeFor(current); } },
      reviewer: { async review() { return { harness: "codex", model: "review", exitCode: 0, result: { verdict: "pass", summary: "pass", findings: [] } }; } },
      adapters: new Map([["fake", adapter]]), artifactRoot: join(root, "artifacts") });
    const result = await worker.runClaimed(task.id, "stage-revision-worker");
    assert.equal(result.status, "done");
    assert.equal(runs, 2);
    const stages = store.stages(task.id);
    assert.deepEqual(stages.map(item => item.role), ["implement", "revise"]);
    assert.deepEqual(stages.map(item => item.status), ["failed", "succeeded"]);
    assert.equal(stages[1]?.predecessorStageId, stages[0]?.id);
    assert.equal(store.handoffs(task.id)[0]?.checks[0]?.status, "failed");
    assert.equal(store.handoffs(task.id)[1]?.checks[0]?.status, "passed");
    const handoff = store.handoffs(task.id)[0]!;
    assert.equal(handoff.task.objective.length, 8_000);
    assert.match(handoff.task.objective, /Truncated; see primary Zero task record/);
    assert.equal(handoff.task.acceptanceCriteria.length, 20);
    assert.ok(handoff.task.acceptanceCriteria[0]!.length <= 1_000);
    assert.match(handoff.task.acceptanceCriteria.at(-1)!, /Additional acceptance criteria were omitted/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
