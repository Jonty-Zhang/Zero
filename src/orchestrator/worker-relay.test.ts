import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore } from "../core/task-store.js";
import { GitWorktreeManager } from "../core/git-worktree.js";
import { TestRunner } from "../core/test-runner.js";
import type { ExecutionSelection, HarnessAdapter, RouteDecision, RunRequest, TaskRecord } from "../domain/types.js";
import { TaskWorker } from "./worker.js";
import { createZeroServer } from "../server/server.js";

const exec = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), ".zero-semantic-relay-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await writeFile(join(repo, "seed.txt"), "base\n");
  await exec("git", ["add", "seed.txt"], { cwd: repo });
  await exec("git", ["commit", "-m", "seed"], { cwd: repo });
  return { root, repo, store: new TaskStore(join(root, "tasks.sqlite")) };
}

function routeFor(task: TaskRecord): RouteDecision {
  const selection = task.selection!;
  assert.deepEqual(Object.keys(selection).sort(), ["harness", "model"], "stage goals must never become locked model-selection fields");
  return { taskId: task.id, harness: selection.harness!, model: selection.model!, selectionSource: "task",
    fieldSources: { harness: "task", model: "task", reasoningEffort: "codex" },
    reason: "semantic relay test", decidedAt: new Date().toISOString() };
}

for (const { rework, failedReworkCheck } of [
  { rework: false, failedReworkCheck: false },
  { rework: true, failedReworkCheck: false },
  { rework: true, failedReworkCheck: true },
]) test(`semantic relay gives each writer its goal and preserves final text${rework ? " through reviewer rework" : ""}${failedReworkCheck ? " and failed rework checks" : ""}`, async () => {
  const { root, repo, store } = await fixture();
  const firstGoal = "Build the storage layer without changing its external contract.";
  const secondGoal = "Integrate the storage layer with the consumer and verify the result.";
  const summary = "Decision: preserve the existing contract because clients depend on it.\nRemaining: integrate the consumer.\nRisk: verify empty inputs. <script>not executable</script>";
  const stages: Array<ExecutionSelection & { objective: string }> = [
    { harness: "writer-a", model: "model-a", objective: firstGoal },
    { harness: "writer-b", model: "model-b", objective: secondGoal },
  ];
  try {
    const task = store.submit({ repoPath: repo, baseRef: "main", prompt: "Build the complete integration", acceptanceCriteria: ["The consumer uses the preserved storage contract"], maxRevisions: failedReworkCheck ? 2 : rework ? 1 : 0,
      executionStages: stages, checks: [{ id: "integration", argv: [process.execPath, "-e", "process.exit(require('node:fs').readFileSync('result.txt','utf8') === 'integrated' ? 0 : 1)"] }] });
    const requests: RunRequest[] = [];
    const routed: TaskRecord[] = [];
    const adapter = (id: string): HarnessAdapter => ({ id,
      async probe() { return { harness: id, available: true, models: [id === "writer-a" ? "model-a" : "model-b"] }; },
      async run(request) {
        requests.push(request);
        await writeFile(join(request.cwd, "result.txt"), failedReworkCheck && requests.length === 4 ? "failed-check" : id === "writer-a" ? "storage" : "integrated");
        return { status: "completed", exitCode: 0, durationMs: 1, final: id === "writer-a" ? `  ${summary}\n` : "Integrated consumer; no remaining implementation work claimed." };
      },
    });
    let reviews = 0;
    const worker = new TaskWorker({ store, worktrees: new GitWorktreeManager(join(root, "worktrees")), testRunner: new TestRunner(),
      router: { async route(current) { routed.push(current); return routeFor(current); } },
      reviewer: { async review(current, _tree, _route, checks) {
        reviews++;
        assert.equal(current.prompt, task.prompt, "stage scope must not replace the review's overall objective");
        assert.ok(checks.every(check => check.status === "passed"));
        return { harness: "codex", model: "review", exitCode: 0, result: rework && reviews === 1
          ? { verdict: "changes_requested", summary: "Preserve empty-input behavior throughout the integration", findings: [{ severity: "high", evidence: "Empty inputs require explicit handling", requestedChange: "Add empty-input handling" }] }
          : { verdict: "pass", summary: "Independent integration review passed", findings: [] } };
      } }, adapters: new Map([["writer-a", adapter("writer-a")], ["writer-b", adapter("writer-b")]]), artifactRoot: join(root, "artifacts") });
    const done = await worker.runNext("relay-worker");
    assert.equal(done?.status, "done", done?.failureReason);
    assert.equal(requests.length, failedReworkCheck ? 6 : rework ? 4 : 2);
    assert.equal(done?.revisionCount, failedReworkCheck ? 2 : rework ? 1 : 0);
    assert.equal(reviews, rework ? 2 : 1, 'check retries must retain the pending reviewer requirements until the next independent review');
    for (const [index, request] of requests.entries()) {
      assert.match(request.prompt, /Build the complete integration/);
      assert.ok(request.prompt.includes(index % 2 === 0 ? firstGoal : secondGoal));
      assert.match(request.prompt, /overall task|original task/i);
      if (index >= 2) assert.match(request.prompt, /Add empty-input handling/);
      if (index >= 4) assert.match(request.prompt, /Failed checks:/);
      assert.ok(routed[index]!.prompt.includes(index % 2 === 0 ? firstGoal : secondGoal), "coordinator must know the current stage's scope");
    }
    const successorPrompt = requests[1]!.prompt;
    assert.match(successorPrompt, /UNTRUSTED/);
    assert.ok(successorPrompt.includes(JSON.stringify(summary)), "the next writer receives the preceding executor's final text as JSON data");
    const attempts = store.attempts(task.id).filter(attempt => attempt.role === "implement" || attempt.role === "revise");
    assert.equal(attempts[0]!.metadata?.executorSummary, summary);
    const handoffs = store.handoffs(task.id);
    assert.equal(handoffs[0]!.executorSummary, summary);
    assert.equal(handoffs[0]!.source.attemptId, attempts[0]!.id);
    assert.equal(handoffs[0]!.checks[0]!.status, "not_run", "executor claims cannot manufacture passed checks");
    assert.equal(handoffs.at(-1)!.checks[0]!.status, "passed");
    const report = await worker.readReport(task.id);
    assert.equal(report?.handoffs?.[0]?.executorSummary, summary);
    assert.equal(report?.attempts[0]?.role, "route");
    const archived = JSON.parse(await readFile(join(root, "artifacts", task.id, "report.json"), "utf8"));
    assert.equal(archived.handoffs[0].executorSummary, summary);
    const server = createZeroServer({ store, config: { async read() { throw new Error('GET evidence must not probe models'); }, async write() {} }, artifactRoot: join(root, 'artifacts') });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${task.id}`);
      assert.equal(response.status, 200);
      const detail = await response.json() as { tests: Array<{ status: string }>; historicalTests: unknown[]; checkEvidence: { state: string; attemptId: string }; handoffs: Array<{ executorSummary?: string }> };
      assert.deepEqual(detail.tests.map(check => check.status), ['passed']);
      assert.equal(detail.historicalTests.length, failedReworkCheck ? 2 : rework ? 1 : 0);
      assert.equal(detail.checkEvidence.state, 'current');
      assert.equal(detail.checkEvidence.attemptId, attempts.at(-1)!.id);
      assert.equal(detail.handoffs[0]!.executorSummary, summary);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
