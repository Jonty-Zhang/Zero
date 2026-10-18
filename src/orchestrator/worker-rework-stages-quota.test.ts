import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../core/task-store.js";
import { GitWorktreeManager } from "../core/git-worktree.js";
import { TestRunner } from "../core/test-runner.js";
import { QuotaLimitError } from "../core/quota.js";
import type { HarnessAdapter, RunRequest } from "../domain/types.js";
import { TaskWorker, type TaskReviewer, type TaskRouter } from "./worker.js";

const exec = promisify(execFile);
const guardian = (id: string) => ({ id: id.repeat(32), lockId: "a".repeat(64), predecessorDrained: true,
  evidenceKind: "guardian_startup_verified" as const });

async function runScenario(options: { pause: "route" | "execute"; reboot: boolean; inspectCheckpoints?: boolean; ambiguousLegacyRoute?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "zero-rework-stage-quota-"));
  const repo = join(root, "repo");
  const dbPath = join(root, "tasks.sqlite");
  await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.name", "Zero Fixture"], { cwd: repo });
  await exec("git", ["config", "user.email", "zero@localhost"], { cwd: repo });
  await writeFile(join(repo, "seed.txt"), "base\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repo });
  let store = new TaskStore(dbPath, guardian("3"));
  try {
    const task = store.submit({ repoPath: repo, baseRef: "main",
      prompt: "Prepare an intermediate plan, consume it, and deliver the approved result without leaving plan.json.",
      acceptanceCriteria: ["result.txt contains approved", "The intermediate plan is absent after the consumer finishes"], maxRevisions: 1,
      executionStages: [{ harness: "planner", model: "planner", objective: "Prepare plan.json for the consumer." },
        { harness: "consumer", model: "consumer", objective: "Consume and remove plan.json, then finish the requested result." }],
      checks: [{ id: "final", argv: [process.execPath, "-e",
        "const fs=require('node:fs');if(fs.existsSync('plan.json')||fs.readFileSync('result.txt','utf8')!=='approved')process.exit(1)"] }] });
    let plannerRuns = 0;
    let consumerRuns = 0;
    let reviews = 0;
    let routePaused = false;
    let resumedRoutePaused = false;
    const calls: string[] = [];
    const planner: HarnessAdapter = { id: "planner", async probe() { return { harness: "planner", available: true, models: ["planner"] }; },
      async run(request) {
        plannerRuns++;
        calls.push("planner");
        await writeFile(join(request.cwd, "plan.json"), JSON.stringify({ result: "approved" }));
        return { status: "completed", exitCode: 0, durationMs: 1, final: "Plan is ready for the consumer." };
      } };
    const consumer: HarnessAdapter = { id: "consumer", async probe() { return { harness: "consumer", available: true, models: ["consumer"] }; },
      async run(request: RunRequest) {
        consumerRuns++;
        calls.push("consumer");
        if (reviews === 1) assert.match(request.prompt, /Create proof\.txt/);
        if (options.pause === "execute" && consumerRuns === 3) {
          assert.equal(await readFile(join(request.cwd, "partial.txt"), "utf8"), "approved");
          await writeFile(join(request.cwd, "proof.txt"), "review proof");
        } else {
          const plan = JSON.parse(await readFile(join(request.cwd, "plan.json"), "utf8")) as { result: string };
          await writeFile(join(request.cwd, "result.txt"), plan.result);
          await rm(join(request.cwd, "plan.json"));
          if (options.pause === "execute" && consumerRuns === 2) {
            await writeFile(join(request.cwd, "partial.txt"), plan.result);
            return { status: "failed", exitCode: 1, durationMs: 1,
              quota: { source: "provider_message", retryAt: new Date(Date.now() + 60_000).toISOString() }, error: "Usage limit" };
          }
          if (reviews === 1) await writeFile(join(request.cwd, "proof.txt"), "review proof");
        }
        return { status: "completed", exitCode: 0, durationMs: 1 };
      } };
    const router: TaskRouter = { async route(current) {
      if (current.selection?.harness === "consumer" && reviews === 1) {
        if (options.pause === "route" && !routePaused) {
          routePaused = true;
          throw new QuotaLimitError("Route quota", new Date(Date.now() + 60_000).toISOString());
        }
        if (options.inspectCheckpoints && consumerRuns === 2 && !resumedRoutePaused) {
          resumedRoutePaused = true;
          throw new QuotaLimitError("Route quota after a paused writer", new Date(Date.now() + 60_000).toISOString());
        }
      }
      return { taskId: current.id, harness: current.selection!.harness!, model: current.selection!.model!,
        selectionSource: "task", reason: "Fixture stage binding", decidedAt: new Date().toISOString() };
    } };
    const reviewer: TaskReviewer = { async review(_task, worktree) {
      reviews++;
      if (reviews > 1) assert.equal(await readFile(join(worktree.path, "proof.txt"), "utf8"), "review proof");
      return { harness: "codex", model: "review", exitCode: 0, result: reviews === 1
        ? { verdict: "changes_requested", summary: "Add the missing proof.", findings: [
          { severity: "medium", evidence: "Proof is missing.", requestedChange: "Create proof.txt without restoring intermediate files." },
        ] }
        : { verdict: "pass", summary: "Approved.", findings: [] } };
    } };
    const makeWorker = () => new TaskWorker({ store, worktrees: new GitWorktreeManager(join(root, "worktrees")),
      testRunner: new TestRunner(), router, reviewer, adapters: new Map([["planner", planner], ["consumer", consumer]]), artifactRoot: join(root, "artifacts") });
    store.claimNext("first-owner");
    const waiting = await makeWorker().runClaimed(task.id, "first-owner");
    assert.equal(waiting.status, "waiting", waiting.failureReason);
    assert.equal(waiting.revisionCount, 1);
    assert.equal(store.quotaCheckpoint(task.id)?.kind, "rework_quota");
    const pausedCallCount = calls.length;
    const editCheckpoint = (edit: (checkpoint: Record<string, unknown>) => void) => {
      const db = new DatabaseSync(dbPath);
      try {
        const checkpoint = JSON.parse((db.prepare("SELECT checkpoint FROM quota_pauses WHERE task_id=?").get(task.id) as { checkpoint: string }).checkpoint) as Record<string, unknown>;
        edit(checkpoint);
        db.prepare("UPDATE quota_pauses SET checkpoint=?,retry_at=? WHERE task_id=?")
          .run(JSON.stringify(checkpoint), new Date(Date.now() - 1_000).toISOString(), task.id);
      } finally { db.close(); }
    };
    if (options.inspectCheckpoints) {
      for (const invalid of [-1, 2, 0, 1.5, "1", null]) {
        editCheckpoint(checkpoint => { checkpoint.executionStageIndex = invalid; });
        assert.equal(await makeWorker().runNext("invalid-index"), undefined, `Reject invalid/mismatched logical stage ${String(invalid)}`);
        assert.equal(store.get(task.id)?.status, "waiting");
        assert.equal(calls.length, pausedCallCount);
      }
      // Old writer checkpoints have no logical index, but their immutable writer_started progress does.
      editCheckpoint(checkpoint => { delete checkpoint.executionStageIndex; });
    } else editCheckpoint(() => {});
    if (options.ambiguousLegacyRoute) {
      editCheckpoint(checkpoint => { delete checkpoint.executionStageIndex; });
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("DROP TRIGGER rework_progress_no_update");
        const attemptId = store.quotaCheckpoint(task.id)!.attemptId;
        for (const row of db.prepare("SELECT id,checkpoint FROM rework_progress WHERE task_id=? AND phase='route_started'").all(task.id) as Array<{ id: string; checkpoint: string }>) {
          const checkpoint = JSON.parse(row.checkpoint) as Record<string, unknown>;
          if (checkpoint.attemptId === attemptId) {
            delete checkpoint.executionStageIndex;
            db.prepare("UPDATE rework_progress SET checkpoint=? WHERE id=?").run(JSON.stringify(checkpoint), row.id);
          }
        }
      } finally { db.close(); }
      assert.equal(await makeWorker().runNext("ambiguous-legacy"), undefined);
      assert.equal(store.get(task.id)?.status, "waiting");
      assert.equal(calls.length, pausedCallCount);
      return;
    }
    if (options.reboot) {
      store.close();
      store = new TaskStore(dbPath, guardian("4"));
    }
    let result = await makeWorker().runNext("resumed-owner");
    if (options.inspectCheckpoints) {
      assert.equal(result?.status, "waiting", "a second route quota retains the paused writer continuation");
      editCheckpoint(() => {});
      result = await makeWorker().runNext("resumed-again-owner");
    }
    assert.equal(result?.status, "done", result?.failureReason);
    assert.equal(plannerRuns, 2, "the already completed planner runs once per content revision");
    assert.equal(consumerRuns, options.pause === "execute" ? 3 : 2);
    assert.equal(result?.revisionCount, 1, "quota retries do not consume another content revision");
    assert.equal(reviews, 2);
    assert.equal(store.checkRuns(task.id).length, 2);
    const resumedEvents = store.events(task.id).filter(event => event.type === "task.review_rework_quota_resumed");
    assert.ok(resumedEvents.length > 0);
    assert.ok(resumedEvents.every(event => event.payload?.executionStageIndex === 1));
    assert.ok(store.handoffs(task.id).some(handoff => handoff.source.harness === "consumer" && handoff.workspace.state !== "unknown"));
  } finally { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

for (const pause of ["execute", "route"] as const) {
  for (const reboot of [false, true]) {
    test(`multi-agent rework ${pause} quota resumes the consumer without replaying the planner ${reboot ? "after guardian reboot" : "in the same generation"}`, async () => {
      await runScenario({ pause, reboot, inspectCheckpoints: pause === "execute" && !reboot });
    });
  }
}

test("an ambiguous legacy multi-agent route checkpoint stays waiting instead of replaying stage zero", async () => {
  await runScenario({ pause: "route", reboot: false, ambiguousLegacyRoute: true });
});
