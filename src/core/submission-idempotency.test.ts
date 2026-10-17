import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { TaskStore } from "./task-store.js";
import { IdempotencyConflictError, submissionRequestHash, validateSubmissionKey } from "./submission-idempotency.js";
import type { TaskSubmission } from "../domain/types.js";

const key = "request-000000000001";
const submission: TaskSubmission = { repoPath: "C:/repo", baseRef: "main", prompt: "Implement the task" };
const requestHash = "a".repeat(64);

test("submission keys reject ambiguous or unbounded headers", () => {
  assert.equal(validateSubmissionKey(key), key);
  assert.equal(validateSubmissionKey("a".repeat(128)), "a".repeat(128));
  for (const value of [undefined, null, [key], 42, "", "a".repeat(15), "a".repeat(129), " invalid-request-key", "request key 12345", "request-key-中文-123456", "request/key/123456"]) {
    assert.throws(() => validateSubmissionKey(value), /idempotency/i);
  }
});

test("request hashing preserves JSON values and array order while ignoring object key order", () => {
  const first = { prompt: "hello", nested: { z: 1, a: [1, { b: true, a: null }] } };
  const reordered = { nested: { a: [1, { a: null, b: true }], z: 1 }, prompt: "hello" };
  assert.match(submissionRequestHash(first), /^[a-f0-9]{64}$/);
  assert.equal(submissionRequestHash(first), submissionRequestHash(reordered));
  assert.notEqual(submissionRequestHash(first), submissionRequestHash({ ...first, prompt: "changed" }));
  assert.notEqual(submissionRequestHash([1, 2]), submissionRequestHash([2, 1]));
  assert.notEqual(submissionRequestHash({}), submissionRequestHash(JSON.parse('{"__proto__":1}')));
  for (const value of [undefined, NaN, Infinity, { invalid: undefined }]) assert.throws(() => submissionRequestHash(value), /JSON/);
});

test("task request replay survives reopening and never emits another submitted event", async () => {
  const root = await mkdtemp(join(tmpdir(), "zero-submission-replay-"));
  const path = join(root, "tasks.sqlite");
  let store = new TaskStore(path);
  try {
    const first = store.submitIdempotent(submission, { key, requestHash });
    assert.equal(first.replayed, false);
    assert.deepEqual(store.lookupSubmissionRequest(key, "task", requestHash), { resourceId: first.record.id });
    assert.equal(store.lookupSubmissionRequest("request-not-yet-used", "task", requestHash), undefined);
    store.fail(first.record.id, "pending", "scheduler could not enqueue");
    store.close();
    store = new TaskStore(path);
    const replay = store.submitIdempotent(submission, { key, requestHash });
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.id, first.record.id);
    assert.equal(replay.record.status, "failed", "replaying must not resubmit failed or already executed tasks");
    assert.equal(store.list().length, 1);
    assert.equal(store.events(first.record.id).filter(event => event.type === "task.submitted").length, 1);
    assert.notEqual(store.submit(submission).id, first.record.id, "legacy requests without keys remain independent submissions");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("one durable key cannot be reused for a changed payload or a different endpoint", () => {
  const store = new TaskStore();
  try {
    store.submitIdempotent(submission, { key, requestHash });
    assert.throws(() => store.lookupSubmissionRequest(key, "task", "b".repeat(64)), IdempotencyConflictError);
    assert.throws(() => store.submitIdempotent({ ...submission, prompt: "changed" }, { key, requestHash: "b".repeat(64) }), IdempotencyConflictError);
    assert.throws(() => store.createSequenceIdempotent([submission, submission], {}, { key, requestHash }), IdempotencyConflictError);
    assert.equal(store.list().length, 1);
    assert.equal(store.listSequences().length, 0);
  } finally { store.close(); }
});

test("sequence failure rolls back tasks, events and request key so a valid retry can succeed", () => {
  const store = new TaskStore();
  try {
    const invalid = { ...submission, executionStages: [{ objective: " " }] };
    assert.throws(() => store.createSequenceIdempotent([submission, invalid], {}, { key, requestHash }), /objective/);
    assert.equal(store.list().length, 0);
    assert.equal(store.listSequences().length, 0);
    assert.equal(store.lookupSubmissionRequest(key, "sequence", requestHash), undefined);
    const first = store.createSequenceIdempotent([submission, { ...submission, prompt: "Second step" }], { objective: "Finish both steps" }, { key, requestHash });
    const replay = store.createSequenceIdempotent([submission, submission], {}, { key, requestHash });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.id, first.record.id);
    assert.equal(replay.record.objective, "Finish both steps");
    assert.deepEqual(replay.record.steps.map(step => step.task.id), first.record.steps.map(step => step.task.id));
    assert.equal(store.list().length, 2);
    assert.equal(store.listSequences().length, 1);
    assert.equal(first.record.steps.reduce((count, step) => count + store.events(step.task.id).filter(event => event.type === "task.submitted").length, 0), 2);
  } finally { store.close(); }
});

test("invalid task insertion does not consume an idempotency key", () => {
  const store = new TaskStore();
  try {
    assert.throws(() => store.submitIdempotent({ ...submission, executionStages: [{ objective: " " }] }, { key, requestHash }), /objective/);
    assert.equal(store.lookupSubmissionRequest(key, "task", requestHash), undefined);
    assert.equal(store.submitIdempotent(submission, { key, requestHash }).replayed, false);
    assert.throws(() => store.submitIdempotent(submission, { key: "bad", requestHash }), /idempotency/i);
    assert.throws(() => store.submitIdempotent(submission, { key: "request-000000000002", requestHash: "invalid" }), /hash/i);
    assert.equal(store.list().length, 1);
  } finally { store.close(); }
});

test("simultaneous requests from independent SQLite stores create exactly one task", async () => {
  const root = await mkdtemp(join(tmpdir(), "zero-submission-concurrent-"));
  const path = join(root, "tasks.sqlite");
  const signal = new SharedArrayBuffer(4);
  const gate = new Int32Array(signal);
  const workers: Worker[] = [];
  const initialized = new TaskStore(path);
  initialized.close();
  try {
    const runs = [0, 1].map(() => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { TaskStore } = await import(workerData.module);
          const store = new TaskStore(workerData.path);
          try {
            parentPort.postMessage({ ready: true });
            Atomics.wait(new Int32Array(workerData.signal), 0, 0);
            const result = store.submitIdempotent(workerData.submission, workerData.request);
            parentPort.postMessage({ id: result.record.id, replayed: result.replayed });
          } finally { store.close(); }
        })().catch(error => { throw error; });
      `, { eval: true, workerData: { module: new URL("./task-store.js", import.meta.url).href, path, signal, submission, request: { key, requestHash } } });
      workers.push(worker);
      let readyResolve!: () => void;
      let resultResolve!: (result: { id: string; replayed: boolean }) => void;
      let rejectReady!: (error: Error) => void;
      let rejectResult!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; rejectReady = reject; });
      const result = new Promise<{ id: string; replayed: boolean }>((resolve, reject) => { resultResolve = resolve; rejectResult = reject; });
      worker.on("message", message => { if (message.ready) readyResolve(); else resultResolve(message); });
      worker.on("error", error => { rejectReady(error); rejectResult(error); });
      return { ready, result };
    });
    await Promise.all(runs.map(run => run.ready));
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0, 2);
    const results = await Promise.all(runs.map(run => run.result));
    assert.equal(results[0]!.id, results[1]!.id);
    assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
    const store = new TaskStore(path);
    try {
      assert.equal(store.list().length, 1);
      assert.equal(store.events(results[0]!.id).filter(event => event.type === "task.submitted").length, 1);
    } finally { store.close(); }
  } finally { await Promise.all(workers.map(worker => worker.terminate())); await rm(root, { recursive: true, force: true }); }
});
