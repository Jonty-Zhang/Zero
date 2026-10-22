import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessAdapter } from "../domain/types.js";
import { TaskStore } from "../core/task-store.js";
import { GitWorktreeManager } from "../core/git-worktree.js";
import { TestRunner } from "../core/test-runner.js";
import { TaskWorker } from "./worker.js";

const exec = promisify(execFile);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 3_000);
    })]);
  } finally { clearTimeout(timer); }
}

test("a delayed worker heartbeat stops the writer and preserves expired work for recovery", async context => {
  const root = await mkdtemp(join(process.cwd(), ".zero-worker-heartbeat-"));
  const repo = join(root, "repo");
  const store = new TaskStore();
  const entered = gate();
  const stopped = gate();
  const released = gate();
  let running: ReturnType<TaskWorker["runNext"]> | undefined;
  let cancellations = 0;
  let reviews = 0;
  try {
    await mkdir(repo);
    for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"]]) {
      await exec("git", args, { cwd: repo, windowsHide: true });
    }
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "."], { cwd: repo, windowsHide: true });
    await exec("git", ["commit", "-m", "fixture"], { cwd: repo, windowsHide: true });
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: "Preserve interrupted changes",
      checks: [{ id: "never-run", argv: [process.execPath, "-e", "process.exit(0)"] }], maxRevisions: 0 });
    const adapter: HarnessAdapter = {
      id: "fake",
      async probe() { return { harness: "fake", available: true, models: ["writer"] }; },
      async run(request) {
        await writeFile(join(request.cwd, "partial.txt"), "interrupted work\n");
        entered.release();
        await released.promise;
        return { status: "cancelled", exitCode: null, durationMs: 1 };
      },
      async cancel() { cancellations++; released.release(); stopped.release(); },
    };
    const worker = new TaskWorker({ store, worktrees: new GitWorktreeManager(join(root, "worktrees")),
      testRunner: new TestRunner(), artifactRoot: join(root, "artifacts"), leaseMs: 60_000, heartbeatIntervalMs: 10,
      adapters: new Map([["fake", adapter]]),
      router: { async route(current) { return { taskId: current.id, harness: "fake", model: "writer", selectionSource: "codex", reason: "fixture", decidedAt: new Date().toISOString() }; } },
      reviewer: { async review() { reviews++; throw new Error("Expired work must not reach review"); } },
    });
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    running = worker.runNext("delayed-worker");
    await bounded(Promise.race([entered.promise, running.then(result => {
      throw new Error(`Worker settled before writer entry: ${JSON.stringify(result)}`);
    })]), "writer entry");
    const expiry = store.get(task.id)!.leaseExpiresAt!;
    context.mock.timers.setTime(Date.parse(expiry) + 1);
    await bounded(stopped.promise, "expired writer cancellation");
    await bounded(running, "worker settlement");
    assert.equal(cancellations, 1);
    assert.equal(store.get(task.id)?.leaseExpiresAt, expiry, "a late heartbeat must not erase the expired deadline");
    assert.deepEqual(store.recoverExpired(), [task.id]);
    assert.equal(store.get(task.id)?.status, "recovery_required");
    assert.equal(store.stages(task.id).at(-1)?.status, "interrupted");
    assert.equal(store.attempts(task.id).at(-1)?.status, "interrupted");
    assert.equal(reviews, 0);
    assert.deepEqual(store.checks(task.id), []);
    assert.deepEqual(store.commitOperations(task.id), []);
    assert.deepEqual(store.reportOperations(task.id), []);
  } finally {
    released.release();
    context.mock.timers.reset();
    try { if (running) await bounded(running, "fixture cleanup"); }
    finally { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
});
