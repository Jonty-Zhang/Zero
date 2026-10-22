import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "./task-store.js";

const startedAt = new Date("2026-01-01T00:00:00.000Z");

for (const status of ["running", "reviewing", "revision"] as const) {
  for (const elapsed of [1_000, 1_001]) {
    test(`${status} heartbeat cannot revive a lease ${elapsed === 1_000 ? "at" : "after"} its deadline`, () => {
      const store = new TaskStore();
      try {
        const task = store.submit({ repoPath: ".", baseRef: "main", prompt: "Keep expired work available for inspection" });
        store.claimNext("old-worker", 1_000, startedAt);
        if (status !== "running") store.transition(task.id, "running", status, { owner: "old-worker" });
        const attempt = store.createAttempt(task.id, status === "reviewing" ? "review" : "implement", { owner: "old-worker" });
        const before = store.get(task.id);
        const events = store.events(task.id);
        const late = new Date(startedAt.getTime() + elapsed);

        assert.equal(store.heartbeat(task.id, "old-worker", 60_000, late), false);
        assert.deepEqual(store.get(task.id), before, "rejected renewal must retain the original expiry and task facts");
        assert.deepEqual(store.events(task.id), events, "rejected renewal must not record a successful heartbeat");
        assert.deepEqual(store.recoverExpired(late), [task.id]);
        assert.equal(store.get(task.id)?.status, "recovery_required");
        assert.equal(store.get(task.id)?.recoveryEvidence?.activeAttemptId, attempt.id);
        assert.equal(store.attempts(task.id).find(item => item.id === attempt.id)?.status, "interrupted");
        assert.equal(store.heartbeat(task.id, "old-worker", 60_000, late), false);
        assert.equal(store.claimNext("new-worker", 60_000, late), undefined, "expiry alone must not authorize replay");
      } finally { store.close(); }
    });
  }

  test(`${status} live owner can renew immediately before the deadline`, () => {
    const store = new TaskStore();
    try {
      const task = store.submit({ repoPath: ".", baseRef: "main", prompt: "Continue a live claim" });
      store.claimNext("current-worker", 1_000, startedAt);
      if (status !== "running") store.transition(task.id, "running", status, { owner: "current-worker" });
      const before = store.get(task.id);
      const now = new Date(startedAt.getTime() + 999);
      assert.equal(store.heartbeat(task.id, "other-worker", 60_000, now), false);
      assert.deepEqual(store.get(task.id), before);
      assert.equal(store.heartbeat(task.id, "current-worker", 60_000, now), true);
      assert.equal(store.get(task.id)?.heartbeatAt, now.toISOString());
      assert.equal(store.get(task.id)?.leaseExpiresAt, new Date(now.getTime() + 60_000).toISOString());
      assert.deepEqual(store.recoverExpired(new Date(startedAt.getTime() + 1_001)), []);
      assert.equal(store.get(task.id)?.status, status);
      assert.equal(store.events(task.id).filter(event => event.type === "task.heartbeat").length, 1);
    } finally { store.close(); }
  });
}
