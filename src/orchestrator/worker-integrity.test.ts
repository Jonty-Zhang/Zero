import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessAdapter, TaskRecord } from "../domain/types.js";
import { GitWorktreeManager, type WorktreeInfo, type WorktreeReviewSnapshot } from "../core/git-worktree.js";
import { TaskStore } from "../core/task-store.js";
import { TestRunner } from "../core/test-runner.js";
import { TaskWorker } from "./worker.js";

const exec = promisify(execFile);

async function runIntegrityScenario(scenario: "content" | "head" | "branch" | "io" | "io-after-inspection" | "outside") {
  const root = await mkdtemp(join(process.cwd(), ".zero-rework-integrity-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await writeFile(join(repo, "seed.txt"), "base");
  await exec("git", ["add", "seed.txt"], { cwd: repo });
  await exec("git", ["commit", "-m", "seed"], { cwd: repo });
  const store = new TaskStore();
  try {
    const mutation = scenario === "head" ? "require('node:child_process').execFileSync('git',['commit','--allow-empty','-m','moved'])"
      : scenario === "branch" ? "require('node:child_process').execFileSync('git',['checkout','-b','unexpected'])"
      : scenario === "outside" ? "fs.writeFileSync('forbidden.txt','outside')"
      : "fs.writeFileSync('result.txt','check changed this')";
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: "Write approved result.txt", maxRevisions: 2,
      allowedPaths: ["result.txt"], checks: [{ id: "approved", argv: [process.execPath, "-e",
        `const fs=require('node:fs'); const value=fs.readFileSync('result.txt','utf8'); if(value==='mutate'){${mutation}} process.exit(0)`] }] });
    const owner = "integrity-worker";
    store.claimNext(owner);
    let writers = 0;
    let reviews = 0;
    class InspectionManager extends GitWorktreeManager {
      override async fingerprint(info: WorktreeInfo): Promise<string> {
        const latestRun = store.checkRuns(task.id).at(-1);
        if (scenario === "io-after-inspection" && writers === 2 && latestRun && store.checkRunIntegrityFailure(latestRun.id)) {
          throw new Error("Simulated fingerprint I/O failure after the fresh inspection");
        }
        return super.fingerprint(info);
      }
      override async captureReviewSnapshot(info: WorktreeInfo): Promise<WorktreeReviewSnapshot> {
        if (scenario === "io" && writers === 2) throw new Error("Simulated Git I/O failure");
        return super.captureReviewSnapshot(info);
      }
    }
    const adapter: HarnessAdapter = { id: "fake",
      async probe() { return { harness: "fake", available: true, models: ["model"] }; },
      async run(request) {
        writers++;
        if (writers === 3) assert.match(request.prompt, /__zero_worktree_integrity__/);
        await writeFile(join(request.cwd, "result.txt"), writers === 1 ? "initial" : writers === 2 ? "mutate" : "approved");
        return { status: "completed", exitCode: 0, durationMs: 1 };
      } };
    const worker = new TaskWorker({ store, worktrees: new InspectionManager(join(root, "worktrees")), testRunner: new TestRunner(),
      router: { async route(current: TaskRecord) { return { taskId: current.id, harness: "fake", model: "model",
        selectionSource: "codex", reason: "fixture", decidedAt: new Date().toISOString() }; } },
      reviewer: { async review() { return { harness: "codex", model: "review", exitCode: 0,
        result: ++reviews === 1
          ? { verdict: "changes_requested", summary: "Strengthen result", findings: [
            { severity: "medium", evidence: "Initial result is incomplete", requestedChange: "Write approved result" }] }
          : { verdict: "pass", summary: "Approved", findings: [] } }; } },
      adapters: new Map([["fake", adapter]]), artifactRoot: join(root, "artifacts") });
    const result = await worker.runClaimed(task.id, owner);
    if (scenario !== "content") {
      assert.equal(result.status, "failed");
      assert.equal(result.revisionCount, 1, "uncertain or unsafe changes cannot consume an automatic retry");
      assert.equal(writers, 2);
      assert.equal(reviews, 1);
      if (scenario !== "io-after-inspection") assert.equal(store.checkRunIntegrityFailure(store.checkRuns(task.id).at(-1)!.id), undefined);
      assert.equal(store.reviewReworkRevisionSteps(task.id, store.getReviewReworkContinuation(task.id)!.id).length, 0);
      return;
    }
    assert.equal(result.status, "done", result.failureReason);
    assert.equal(result.revisionCount, 2);
    assert.equal(writers, 3);
    assert.equal(reviews, 2);
    const continuation = store.getReviewReworkContinuation(task.id)!;
    const steps = store.reviewReworkRevisionSteps(task.id, continuation.id);
    assert.equal(steps.length, 1);
    assert.deepEqual(steps[0]?.failedCheckIds, ["__zero_worktree_integrity__"]);
    const failedRun = store.getCheckRun(steps[0]!.failedCheckRunId)!;
    assert.deepEqual(failedRun.expectedCheckIds, ["approved"]);
    assert.ok(store.checkRunResults(failedRun.id).every(check => check.status === "passed" && check.exitCode === 0));
    assert.equal(store.checkRuns(task.id).length, 3);
    assert.equal(store.reviewPackages(task.id).length, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test("review rework retries an independently recorded integrity failure after passing commands", () => runIntegrityScenario("content"));
for (const scenario of ["head", "branch", "io", "io-after-inspection", "outside"] as const) {
  test(`review rework refuses automatic integrity retries after ${scenario} changes`, () => runIntegrityScenario(scenario));
}
