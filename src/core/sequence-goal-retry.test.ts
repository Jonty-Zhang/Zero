import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { GoalReviewRetryConflictError, TaskStore } from "./task-store.js";
import type { ReviewResult, TaskSequenceRecord } from "../domain/types.js";

const fingerprint = "a".repeat(64);
const at = new Date("2026-10-18T00:00:00.000Z");
const sourceAttemptId = "zzzz-source-attempt";

function verdict(value: ReviewResult["verdict"]): ReviewResult {
  return { verdict: value, summary: value === "blocked" ? "Reviewer temporarily unavailable." : "Review result.",
    findings: value === "pass" ? [] : [{ severity: "medium", evidence: "Review could not pass.", requestedChange: "Check the result." }] };
}

async function withFixture(run: (f: { store: TaskStore; path: string; sequence: TaskSequenceRecord; reopen(): void }) => Promise<void> | void,
  options: { state?: "absent" | "running" | "quota" | ReviewResult["verdict"]; goalMetadata?: boolean; done?: boolean } = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zero-sequence-goal-retry-"));
  const path = join(root, "tasks.sqlite");
  const f = { path, store: new TaskStore(path),
    sequence: undefined as unknown as TaskSequenceRecord,
    reopen() { this.store.close(); this.store = new TaskStore(path); } };
  try {
    f.sequence = f.store.createSequence([
      { repoPath: ".", baseRef: "main", prompt: "Complete the first step.", maxRevisions: 2 },
      { repoPath: ".", baseRef: "main", prompt: "Complete the second step.", maxRevisions: 0 },
    ], "retry-sequence", options.goalMetadata === false ? {} : { objective: "Complete both steps.", maxGoalRevisions: 0 });
    const db = new DatabaseSync(path);
    try {
      if (options.done !== false) db.prepare("UPDATE tasks SET status='done',revision_count=CASE WHEN id=? THEN 2 ELSE 0 END")
        .run(f.sequence.steps[0]!.task.id);
    } finally { db.close(); }
    if (options.goalMetadata !== false && options.done !== false && options.state !== "absent") {
      f.store.startSequenceGoalReview(f.sequence.id, fingerprint, sourceAttemptId, at);
      const state = options.state ?? "blocked";
      if (state === "quota") f.store.finishSequenceGoalReview({ attemptId: sourceAttemptId, now: at,
        retryAt: new Date(at.getTime() + 60_000).toISOString() });
      else if (state !== "running") f.store.finishSequenceGoalReview({ attemptId: sourceAttemptId, now: at,
        verifiedEvidenceFingerprint: fingerprint, result: verdict(state) });
    }
    await run(f);
  } finally { f.store.close(); await rm(root, { recursive: true, force: true }); }
}

function conflict(action: () => unknown): void {
  assert.throws(action, GoalReviewRetryConflictError);
}

test("blocked review retry requests are idempotent, visible and durable without changing verdict or budgets", async () => {
  await withFixture(f => {
    const previous = f.store.sequenceGoalReview(f.sequence.id)!;
    const tasks = f.store.getSequence(f.sequence.id)!.steps.map(step => step.task);
    const request = f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, new Date(at.getTime() + 1));
    assert.deepEqual(request, { sequenceId: f.sequence.id, sourceAttemptId, requestedAt: "2026-10-18T00:00:00.001Z" });
    assert.deepEqual(f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, new Date(at.getTime() + 10)), request);
    assert.deepEqual(f.store.sequenceGoalReview(f.sequence.id), previous);
    f.reopen();
    assert.deepEqual(f.store.pendingSequenceGoalReviewRetry(f.sequence.id), request);
    const sequence = f.store.getSequence(f.sequence.id)!;
    assert.equal(sequence.status, "blocked");
    assert.equal(sequence.goalReview?.retryRequestedAt, request.requestedAt);
    assert.deepEqual(sequence.steps.map(step => step.task), tasks);
    assert.equal(sequence.maxGoalRevisions, 0);
    assert.equal(sequence.goalRevisionCount, 0);
    assert.equal(f.store.events(sequence.steps[0]!.task.id).filter(event => event.type === "task_sequence.goal_review_retry_requested").length, 1);
  });
});

test("retry consumption is atomic and creates the latest review even with inverse IDs in the same millisecond", async () => {
  await withFixture(f => {
    f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, at);
    const fresh = f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "aaaa-fresh-attempt", at, sourceAttemptId);
    assert.equal(fresh.createdAt, "2026-10-18T00:00:00.001Z");
    assert.equal(f.store.sequenceGoalReview(f.sequence.id)?.attemptId, fresh.attemptId);
    assert.equal(f.store.pendingSequenceGoalReviewRetry(f.sequence.id), undefined);
    assert.equal(f.store.getSequence(f.sequence.id)!.goalReview?.retryRequestedAt, undefined);
    conflict(() => f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "duplicate-attempt", at, sourceAttemptId));
    conflict(() => f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, at));
    assert.equal(f.store.sequenceGoalReviewByAttempt("duplicate-attempt"), undefined);
    assert.equal(f.store.sequenceGoalReviewByAttempt(sourceAttemptId)?.result?.verdict, "blocked");
    const started = f.store.events(f.sequence.steps[0]!.task.id).filter(event => event.type === "task_sequence.goal_review_started");
    assert.equal(started.length, 2);
    assert.equal(started.at(-1)?.payload?.retryOfAttemptId, sourceAttemptId);
  });
});

test("a guarded review cannot start without its exact retry request or with a stale source", async () => {
  await withFixture(f => {
    conflict(() => f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "without-request", at, sourceAttemptId));
    assert.equal(f.store.sequenceGoalReviewByAttempt("without-request"), undefined);
    conflict(() => f.store.requestSequenceGoalReviewRetry(f.sequence.id, "wrong-attempt", at));
    f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, at);
    f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "newer-review", new Date(at.getTime() + 10));
    f.store.finishSequenceGoalReview({ attemptId: "newer-review", result: verdict("blocked"), verifiedEvidenceFingerprint: fingerprint });
    assert.equal(f.store.pendingSequenceGoalReviewRetry(f.sequence.id), undefined);
    conflict(() => f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "stale-start", at, sourceAttemptId));
    assert.equal(f.store.sequenceGoalReviewByAttempt("stale-start"), undefined);
    f.store.requestSequenceGoalReviewRetry(f.sequence.id, "newer-review", at);
    assert.equal(f.store.pendingSequenceGoalReviewRetry(f.sequence.id)?.sourceAttemptId, "newer-review");
  });
});

test("ordinary review start rejects an old captured source even after its successor has finished", async () => {
  await withFixture(f => {
    f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, at);
    f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "manual-successor", at, sourceAttemptId, sourceAttemptId);
    f.store.finishSequenceGoalReview({ attemptId: "manual-successor", result: verdict("blocked"), verifiedEvidenceFingerprint: fingerprint });
    conflict(() => f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "stale-automatic", at, undefined, sourceAttemptId));
    conflict(() => f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "false-initial", at, undefined, null));
    assert.equal(f.store.sequenceGoalReviewByAttempt("stale-automatic"), undefined);
    assert.equal(f.store.sequenceGoalReviewByAttempt("false-initial"), undefined);
  });
});

test("a null previous-attempt guard accepts the first review and rejects a second initial contender", async () => {
  await withFixture(f => {
    const sequence = f.store.createSequence([
      { repoPath: "./second", baseRef: "main", prompt: "First step in another goal." },
      { repoPath: "./second", baseRef: "main", prompt: "Second step in another goal." },
    ], "initial-retry-sequence", { objective: "A new goal." });
    const db = new DatabaseSync(f.path);
    try { for (const step of sequence.steps) db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(step.task.id); }
    finally { db.close(); }
    f.store.startSequenceGoalReview(sequence.id, fingerprint, "initial-winner", at, undefined, null);
    f.store.finishSequenceGoalReview({ attemptId: "initial-winner", result: verdict("blocked"), verifiedEvidenceFingerprint: fingerprint });
    conflict(() => f.store.startSequenceGoalReview(sequence.id, fingerprint, "initial-loser", at, undefined, null));
    assert.equal(f.store.sequenceGoalReviewByAttempt("initial-loser"), undefined);
  });
});

for (const state of ["running", "quota", "pass", "changes_requested"] as const) {
  test(`retry cannot bypass ${state}, even after reopening or a quota deadline`, async () => {
    await withFixture(f => {
      f.reopen();
      conflict(() => f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, new Date(at.getTime() + 120_000)));
      conflict(() => f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "forbidden-start", at, sourceAttemptId));
      assert.equal(f.store.pendingSequenceGoalReviewRetry(f.sequence.id), undefined);
      assert.equal(f.store.sequenceGoalReviewByAttempt("forbidden-start"), undefined);
    }, { state });
  });
}

for (const options of [{ goalMetadata: false }, { done: false }]) {
  test(`retry rejects sequences without ${options.goalMetadata === false ? "goal metadata" : "completed steps"}`, async () => {
    await withFixture(f => {
      conflict(() => f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, at));
      conflict(() => f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "ineligible", at, sourceAttemptId));
      assert.equal(f.store.pendingSequenceGoalReviewRetry(f.sequence.id), undefined);
    }, options);
  });
}

test("a queued request becomes unusable if a step is no longer DONE", async () => {
  await withFixture(f => {
    f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, at);
    const db = new DatabaseSync(f.path);
    try { db.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(f.sequence.steps[1]!.task.id); }
    finally { db.close(); }
    assert.equal(f.store.pendingSequenceGoalReviewRetry(f.sequence.id), undefined);
    conflict(() => f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "incomplete-start", at, sourceAttemptId));
    conflict(() => f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, at));
  });
});

test("each new blocked result needs another explicit request and goal revision caps remain unchanged", async () => {
  await withFixture(f => {
    f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, at);
    f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "second-blocked", at, sourceAttemptId);
    f.store.finishSequenceGoalReview({ attemptId: "second-blocked", result: verdict("blocked"), verifiedEvidenceFingerprint: fingerprint });
    assert.equal(f.store.pendingSequenceGoalReviewRetry(f.sequence.id), undefined);
    conflict(() => f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "unrequested-third", at, "second-blocked"));
    f.store.requestSequenceGoalReviewRetry(f.sequence.id, "second-blocked", at);
    f.store.startSequenceGoalReview(f.sequence.id, fingerprint, "third-review", at, "second-blocked");
    f.store.finishSequenceGoalReview({ attemptId: "third-review", result: verdict("changes_requested"), verifiedEvidenceFingerprint: fingerprint });
    assert.throws(() => f.store.appendSequenceGoalRevision(f.sequence.id, "third-review",
      { repoPath: ".", baseRef: "main", prompt: "Do not exceed the user's zero revision cap." }), /limit reached/);
    assert.equal(f.store.getSequence(f.sequence.id)?.goalRevisionCount, 0);
    assert.equal(f.store.getSequence(f.sequence.id)?.maxGoalRevisions, 0);
  });
});

async function raceStores(path: string, action: "request" | "start" | "initial") {
  const signal = new SharedArrayBuffer(4);
  const workers: Worker[] = [];
  try {
    const runs = [0, 1].map(index => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { TaskStore } = await import(workerData.module);
          const store = new TaskStore(workerData.path);
          try {
            parentPort.postMessage({ ready: true });
            Atomics.wait(new Int32Array(workerData.signal), 0, 0);
            try {
              const result = workerData.action === 'request'
                ? store.requestSequenceGoalReviewRetry('retry-sequence', workerData.source, new Date(workerData.at))
                : store.startSequenceGoalReview('retry-sequence', workerData.fingerprint, 'racing-' + workerData.index, new Date(workerData.at),
                    workerData.action === 'initial' ? undefined : workerData.source,
                    workerData.action === 'initial' ? null : workerData.source);
              parentPort.postMessage({ ok: true, result });
            } catch (error) { parentPort.postMessage({ ok: false, error: error.name }); }
          } finally { store.close(); }
        })().catch(error => { throw error; });
      `, { eval: true, workerData: { module: new URL("./task-store.js", import.meta.url).href, path, signal, action, index,
        source: sourceAttemptId, at: at.toISOString(), fingerprint } });
      workers.push(worker);
      let readyResolve!: () => void;
      let resultResolve!: (value: { ok: boolean; result?: Record<string, unknown>; error?: string }) => void;
      let readyReject!: (error: Error) => void;
      let resultReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const result = new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
      worker.on("message", message => { if (message.ready) readyResolve(); else resultResolve(message); });
      worker.on("error", error => { readyReject(error); resultReject(error); });
      return { ready, result };
    });
    await Promise.all(runs.map(run => run.ready));
    Atomics.store(new Int32Array(signal), 0, 1);
    Atomics.notify(new Int32Array(signal), 0, 2);
    return await Promise.all(runs.map(run => run.result));
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

test("independent SQLite connections coalesce requests and only one scheduler can consume them", async () => {
  await withFixture(async f => {
    const requests = await raceStores(f.path, "request");
    assert.ok(requests.every(result => result.ok));
    assert.deepEqual(requests[0]!.result, requests[1]!.result);
    const starts = await raceStores(f.path, "start");
    assert.equal(starts.filter(result => result.ok).length, 1);
    assert.equal(starts.find(result => !result.ok)?.error, "GoalReviewRetryConflictError");
    assert.equal(f.store.pendingSequenceGoalReviewRetry(f.sequence.id), undefined);
    const events = f.store.events(f.sequence.steps[0]!.task.id);
    assert.equal(events.filter(event => event.type === "task_sequence.goal_review_retry_requested").length, 1);
    assert.equal(events.filter(event => event.type === "task_sequence.goal_review_started").length, 2);
  });
});

test("independent SQLite schedulers create only one initial review with a null previous-attempt guard", async () => {
  await withFixture(async f => {
    conflict(() => f.store.requestSequenceGoalReviewRetry(f.sequence.id, sourceAttemptId, at));
    const starts = await raceStores(f.path, "initial");
    assert.equal(starts.filter(result => result.ok).length, 1);
    assert.equal(starts.find(result => !result.ok)?.error, "GoalReviewRetryConflictError");
    assert.equal(f.store.events(f.sequence.steps[0]!.task.id).filter(event => event.type === "task_sequence.goal_review_started").length, 1);
  }, { state: "absent" });
});

test("missing sequences cannot request or start a guarded retry", () => {
  const store = new TaskStore();
  try {
    conflict(() => store.requestSequenceGoalReviewRetry("missing", sourceAttemptId, at));
    conflict(() => store.startSequenceGoalReview("missing", fingerprint, "missing-attempt", at, sourceAttemptId));
    assert.equal(store.pendingSequenceGoalReviewRetry("missing"), undefined);
  } finally { store.close(); }
});
