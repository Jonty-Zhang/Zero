import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  Attempt,
  CheckDefinition,
  CheckResult,
  HandoffRecord,
  HandoffV1,
  HarnessAdapter,
  ReviewResult,
  RouteDecision,
  StageRecord,
  StageStatus,
  TaskRecord,
  TaskStatus,
} from "../domain/types.js";
import { GitWorktreeManager, type WorktreeInfo } from "../core/git-worktree.js";
import { TaskStore } from "../core/task-store.js";
import { TestRunner } from "../core/test-runner.js";
import { QuotaLimitError, quotaRetryAt } from "../core/quota.js";
import { HANDOFF_V1_MAX_BYTES } from "../domain/handoff.js";

type ResumeStage = "route" | "execute" | "review";
interface WorkerCheckpoint {
  version: 1;
  stage: ResumeStage;
  baseCommit: string;
  worktreeFingerprint: string;
  revision: number;
  revisionBrief: string;
  finalRoute?: RouteDecision;
  finalChecks?: CheckResult[];
}

export interface RouteContext {
  attemptId: string;
  cwd: string;
  baseCommit: string;
  checks: CheckDefinition[];
  revision: number;
  previousDecision?: RouteDecision;
}

export interface TaskRouter {
  /** Codex-backed allocation. Must return a route limited to probed executable bindings. */
  route(task: TaskRecord, context: RouteContext): Promise<RouteDecision>;
}

export interface ReviewExecution {
  result: ReviewResult;
  harness: "codex";
  model: string;
  reasoningEffort?: string;
  exitCode: number;
  stdoutPath?: string;
  stderrPath?: string;
  eventsPath?: string;
}

export interface TaskReviewer {
  /** Must run a new read-only Codex session and return a schema-validated verdict. */
  review(task: TaskRecord, worktree: WorktreeInfo, route: RouteDecision, checks: CheckResult[], diff: string, context: { attemptId: string }): Promise<ReviewExecution>;
}

export interface TaskWorkerOptions {
  store: TaskStore;
  worktrees: GitWorktreeManager;
  testRunner: TestRunner;
  router: TaskRouter;
  reviewer: TaskReviewer;
  adapters: ReadonlyMap<string, HarnessAdapter>;
  artifactRoot: string;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
}

export interface TaskReport {
  schemaVersion: 1;
  taskId: string;
  finalStatus: TaskStatus;
  createdAt: string;
  updatedAt: string;
  task: TaskRecord;
  baseCommit?: string;
  resultCommit?: string;
  routeDecisions: RouteDecision[];
  attempts: Attempt[];
  /** Optional for backwards compatibility with previously archived schemaVersion 1 reports. */
  stages?: StageRecord[];
  handoffs?: HandoffRecord[];
  checks: CheckResult[];
  reviews: ReviewResult[];
  diffPath?: string;
  error?: string;
}

/** Executes one leased task. SQLite remains authoritative; external work is never retried after an interrupted attempt. */
export class TaskWorker {
  readonly #options: Required<Pick<TaskWorkerOptions, "leaseMs" | "heartbeatIntervalMs">> & TaskWorkerOptions;
  readonly #active = new Map<string, { controller: AbortController; adapter?: HarnessAdapter; attempt?: Attempt; cancelRequested: boolean }>();

  constructor(options: TaskWorkerOptions) {
    this.#options = { leaseMs: 60_000, heartbeatIntervalMs: Math.max(1_000, Math.floor((options.leaseMs ?? 60_000) / 3)), ...options };
    if (!options.artifactRoot) throw new Error("artifactRoot is required");
  }

  async runNext(owner = `worker-${randomUUID()}`): Promise<TaskRecord | undefined> {
    const task = this.#options.store.claimNext(owner, this.#options.leaseMs);
    if (!task) return undefined;
    return this.runClaimed(task.id, owner);
  }

  async runClaimed(taskId: string, owner: string): Promise<TaskRecord> {
    let task = this.#requireTask(taskId);
    if (task.status !== "running" || task.leaseOwner !== owner) throw new Error(`Task ${taskId} is not leased by ${owner}`);
    if (this.#active.has(taskId)) throw new Error(`Task ${taskId} is already active in this worker`);
    const active = { controller: new AbortController(), cancelRequested: false } as { controller: AbortController; adapter?: HarnessAdapter; attempt?: Attempt; cancelRequested: boolean };
    this.#active.set(taskId, active);
    let leaseLost = false;
    let activeAttempt: Attempt | undefined;
    let executionStage: StageRecord | undefined;
    let executionAttempt: Attempt | undefined;
    let executionChecks: CheckResult[] = [];
    let finalizedExecutionFingerprint: string | undefined;
    let worktree: WorktreeInfo | undefined;
    let baseCommit: string | undefined;
    let resultCommit: string | undefined;
    let errorMessage: string | undefined;
    let markedDone = false;
    let stage: ResumeStage = "route";
    let revision = 0;
    let revisionBrief = task.prompt;
    let finalRoute: RouteDecision | undefined;
    let finalChecks: CheckResult[] = [];
    let continuingExecution = false;
    const interval = setInterval(() => {
      try {
        if (!this.#options.store.heartbeat(taskId, owner, this.#options.leaseMs)) {
          leaseLost = true;
          active.controller.abort(new Error("Task lease was lost"));
          if (active.adapter && active.attempt) void active.adapter.cancel?.(taskId, active.attempt.id).catch(() => undefined);
        }
      } catch {
        leaseLost = true;
        active.controller.abort(new Error("Task lease was lost"));
        if (active.adapter && active.attempt) void active.adapter.cancel?.(taskId, active.attempt.id).catch(() => undefined);
      }
    }, this.#options.heartbeatIntervalMs);
    interval.unref?.();

    try {
      const priorAttempts = this.#options.store.attempts(taskId);
      const checkpoint = parseCheckpoint(task.resumeCheckpoint);
      this.#assertNotCancelled(active);
      if (priorAttempts.some(attempt => attempt.status === "interrupted")) {
        throw new Error("An earlier attempt was interrupted; inspect its process, artifacts, and worktree before retrying");
      }
      if (checkpoint) {
        if (task.revisionCount !== checkpoint.revision) throw new Error("Quota checkpoint revision does not match the task record");
        if (!await this.#options.worktrees.exists(taskId)) throw new Error("Quota checkpoint worktree is missing");
        worktree = await this.#options.worktrees.reopen(taskId, task.repoPath, checkpoint.baseCommit);
        const fingerprint = await this.#worktreeFingerprint(worktree);
        if (fingerprint !== checkpoint.worktreeFingerprint) throw new Error("Quota checkpoint worktree changed while waiting; inspection is required");
        baseCommit = checkpoint.baseCommit;
        stage = checkpoint.stage;
        revision = checkpoint.revision;
        revisionBrief = checkpoint.revisionBrief;
        finalRoute = checkpoint.finalRoute;
        finalChecks = checkpoint.finalChecks ?? [];
        continuingExecution = stage === "execute";
        if (stage !== "route" && !finalRoute) throw new Error("Quota checkpoint has no execution route");
        if (finalRoute) this.#validateRoute(task, finalRoute);
        if (stage === "review" && (!finalChecks.length || finalChecks.some(check => check.status !== "passed"))) {
          throw new Error("Quota checkpoint has no passing validation evidence for review");
        }
      } else {
        // A crash can happen after worktree creation but before the first attempt row is committed.
        if (await this.#options.worktrees.exists(taskId)) {
          throw new Error("An existing task worktree requires recovery inspection; refusing to create or reuse it automatically");
        }
        worktree = await this.#options.worktrees.create(taskId, task.repoPath, task.baseRef);
        baseCommit = worktree.baseCommit;
      }
      this.#assertNotCancelled(active);
      this.#assertLease(taskId, owner, () => leaseLost);

      const requiredChecks = task.checks ?? [];
      if (!requiredChecks.length) throw new Error("No validation checks are configured; this task cannot be marked DONE");
      const maximumRevisions = Math.max(0, task.maxRevisions ?? 0);
      let finalReview: ReviewResult | undefined;

      while (true) {
        task = this.#requireTask(taskId);
        this.#assertLease(taskId, owner, () => leaseLost);
        if (stage === "route") {
          const routeAttempt = this.#options.store.createAttempt(taskId, "route", { owner, harness: "codex" });
          activeAttempt = routeAttempt;
          active.adapter = this.#options.adapters.get("codex");
          active.attempt = routeAttempt;
          this.#assertNotCancelled(active);
          try {
            const route = await this.#options.router.route(task, {
              attemptId: routeAttempt.id,
              cwd: worktree.path,
              baseCommit,
              checks: requiredChecks,
              revision,
              ...(finalRoute ? { previousDecision: finalRoute } : {}),
            });
            this.#validateRoute(task, route);
            this.#options.store.saveRoute(route);
            this.#options.store.finishAttempt(routeAttempt.id, {
              status: "succeeded",
              stdoutPath: route.artifacts?.stdoutPath,
              stderrPath: route.artifacts?.stderrPath,
              resultPath: route.artifacts?.eventsPath,
              metadata: { decision: route },
            });
            finalRoute = route;
            stage = "execute";
          } catch (error) {
            this.#options.store.finishAttempt(routeAttempt.id, { status: "failed", error: errorText(error) });
            activeAttempt = undefined;
            active.adapter = undefined;
            active.attempt = undefined;
            throw error;
          }
          activeAttempt = undefined;
          active.adapter = undefined;
          active.attempt = undefined;
          this.#assertNotCancelled(active);
        }
        const route = finalRoute;
        if (!route) throw new Error("Execution route is missing");
        if (stage === "execute") {
        const adapter = this.#options.adapters.get(route.harness);
        if (!adapter) throw new Error(`No HarnessAdapter is registered for ${route.harness}`);
        const role = revision === 0 ? "implement" : "revise";
        const inputFingerprint = await this.#options.worktrees.fingerprint(worktree);
        const previousExecutionStage = this.#options.store.stages(taskId).filter(item => item.role === "implement" || item.role === "revise").at(-1);
        const processStartId = randomUUID();
        const pendingStage = this.#options.store.createStage(taskId, {
          role,
          ...(previousExecutionStage ? { predecessorStageId: previousExecutionStage.id } : {}),
          harness: route.harness,
          model: route.model,
          reasoningEffort: route.effectiveReasoningEffort ?? route.reasoningEffort,
          configHash: route.configHash,
          processStartId,
          inputFingerprint,
        });
        executionStage = this.#options.store.startStage(pendingStage.id, owner, processStartId);
        executionChecks = [];
        const attempt = this.#options.store.createAttempt(taskId, role, {
          owner, stageId: executionStage.id, harness: route.harness, model: route.model,
          reasoningEffort: route.effectiveReasoningEffort ?? route.reasoningEffort,
          configHash: route.configHash,
          metadata: { revision },
        });
        executionAttempt = attempt;
        activeAttempt = attempt;
        active.adapter = adapter;
        active.attempt = attempt;
        this.#assertNotCancelled(active);
        const runResult = await adapter.run({
          taskId,
          attemptId: attempt.id,
          role,
          cwd: worktree.path,
          prompt: continuingExecution
            ? `${revisionBrief}\n\nZero paused this attempt after a verified provider usage limit. Continue in this same worktree. Inspect the existing changes first, preserve correct work, and complete the task.`
            : revisionBrief,
          harness: route.harness,
          model: route.model,
          reasoningEffort: route.effectiveReasoningEffort ?? route.reasoningEffort,
          baseCommit,
          allowedPaths: task.allowedPaths,
          artifactDir: this.#artifactDirectory(taskId),
          deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
        });
        this.#options.store.finishAttempt(attempt.id, {
          status: runResult.status === "completed" && runResult.exitCode === 0 ? "succeeded" : runResult.status === "cancelled" ? "interrupted" : "failed",
          exitCode: runResult.exitCode ?? undefined,
          stdoutPath: runResult.stdoutPath,
          stderrPath: runResult.stderrPath,
          resultPath: runResult.eventsPath,
          error: runResult.error,
          metadata: { actualModel: runResult.actualModel, durationMs: runResult.durationMs, sessionId: runResult.sessionId },
        }, { owner, processStartId });
        activeAttempt = undefined;
        active.adapter = undefined;
        active.attempt = undefined;
        this.#assertNotCancelled(active);
        if (runResult.status !== "completed" || runResult.exitCode !== 0) {
          if (runResult.quota) throw new QuotaLimitError(`Execution Harness reached a usage limit (${route.harness}/${route.model})`, runResult.quota.retryAt);
          throw new Error(`Execution Harness failed (${runResult.status}, exit ${String(runResult.exitCode)}): ${runResult.error ?? "no additional details"}`);
        }
        continuingExecution = false;
        this.#assertLease(taskId, owner, () => leaseLost);

        const changedPaths = await this.#options.worktrees.changedPaths(worktree);
        this.#assertAllowedPaths(task, changedPaths);
        const checks = await this.#options.testRunner.run(requiredChecks, worktree.path, { signal: active.controller.signal });
        finalChecks = checks;
        executionChecks = checks;
        for (const check of checks) this.#options.store.saveCheck(taskId, check, attempt.id);
        this.#assertNotCancelled(active);
        this.#assertAllowedPaths(task, await this.#options.worktrees.changedPaths(worktree));
        const failedChecks = checks.filter(check => check.status !== "passed");
        if (failedChecks.length) {
          await this.#finishExecutionStage({
            task, worktree, stage: executionStage, attempt: executionAttempt, route, owner,
            status: "failed", checks, summary: "Zero observed one or more failed validation checks.",
          });
          executionStage = undefined;
          executionAttempt = undefined;
          if (revision >= maximumRevisions) throw new Error(`Validation failed after ${revision} content revisions: ${failedChecks.map(check => check.id).join(", ")}`);
          const brief = this.#revisionBrief(task, failedChecks, undefined, revision + 1);
          task = this.#options.store.transition(taskId, "running", "revision", { owner, incrementRevision: true, reason: "validation checks failed" });
          revision++;
          revisionBrief = brief;
          task = this.#options.store.transition(taskId, "revision", "running", { owner, reason: "starting validation revision" });
          stage = "route";
          continue;
        }

        await this.#finishExecutionStage({
          task, worktree, stage: executionStage, attempt: executionAttempt, route, owner,
          status: "succeeded", checks, summary: "Zero observed successful execution and passing validation checks.",
        });
        executionStage = undefined;
        executionAttempt = undefined;

        task = this.#options.store.transition(taskId, "running", "reviewing", { owner, reason: "validation checks passed" });
        stage = "review";
        }
        if (stage !== "review") throw new Error("Worker has no resumable stage");
        if (task.status === "running") task = this.#options.store.transition(taskId, "running", "reviewing", { owner, reason: "resuming quota-paused review" });
        this.#assertNotCancelled(active);
        const diffBefore = await this.#options.worktrees.diff(worktree);
        const statusBefore = await this.#options.worktrees.status(worktree);
        const reviewAttempt = this.#options.store.createAttempt(taskId, "review", { owner, harness: "codex" });
        activeAttempt = reviewAttempt;
        active.adapter = this.#options.adapters.get("codex");
        active.attempt = reviewAttempt;
        this.#assertNotCancelled(active);
        const review = await this.#options.reviewer.review(task, worktree, route, finalChecks, diffBefore, { attemptId: reviewAttempt.id });
        const diffAfter = await this.#options.worktrees.diff(worktree);
        const statusAfter = await this.#options.worktrees.status(worktree);
        if (statusAfter !== statusBefore || hash(diffAfter) !== hash(diffBefore)) {
          this.#options.store.finishAttempt(reviewAttempt.id, { status: "failed", exitCode: review.exitCode,
            stdoutPath: review.stdoutPath, stderrPath: review.stderrPath, resultPath: review.eventsPath,
            model: review.model, reasoningEffort: review.reasoningEffort,
            error: "Reviewer changed the worktree despite read-only mode" });
          activeAttempt = undefined;
          throw new Error("Reviewer changed the worktree; its verdict is invalid");
        }
        if (review.harness !== "codex" || review.exitCode !== 0 || !isReviewResult(review.result)) {
          this.#options.store.finishAttempt(reviewAttempt.id, { status: "failed", exitCode: review.exitCode,
            stdoutPath: review.stdoutPath, stderrPath: review.stderrPath, resultPath: review.eventsPath,
            model: review.model, reasoningEffort: review.reasoningEffort,
            error: `Reviewer failed or returned an invalid verdict: ${review.result.summary}` });
          activeAttempt = undefined;
          throw new Error("Codex Reviewer failed or returned an invalid verdict");
        }
        this.#options.store.saveReview(taskId, review.result, reviewAttempt.id);
        this.#options.store.finishAttempt(reviewAttempt.id, {
          status: "succeeded", exitCode: review.exitCode, harness: review.harness,
          model: review.model, reasoningEffort: review.reasoningEffort,
          stdoutPath: review.stdoutPath,
          stderrPath: review.stderrPath,
          resultPath: review.eventsPath,
        });
        activeAttempt = undefined;
        active.adapter = undefined;
        active.attempt = undefined;
        this.#assertNotCancelled(active);
        finalReview = review.result;
        if (review.result.verdict === "blocked") throw new Error(`Review blocked: ${review.result.summary}`);
        if (review.result.verdict === "changes_requested") {
          if (revision >= maximumRevisions) throw new Error(`Review requested changes after ${revision} content revisions: ${review.result.summary}`);
          const brief = this.#revisionBrief(task, [], review.result, revision + 1);
          task = this.#options.store.transition(taskId, "reviewing", "revision", { owner, incrementRevision: true, reason: "review requested changes" });
          revision++;
          revisionBrief = brief;
          task = this.#options.store.transition(taskId, "revision", "running", { owner, reason: "starting review revision" });
          stage = "route";
          continue;
        }

        this.#assertLease(taskId, owner, () => leaseLost);
        this.#assertAllowedPaths(task, await this.#options.worktrees.changedPaths(worktree));
        resultCommit = await this.#options.worktrees.commit(worktree, `Zero task ${taskId}`);
        this.#assertNotCancelled(active);
        if (!resultCommit) throw new Error("No changes were committed; refusing to mark a no-op task DONE");
        const diff = await this.#options.worktrees.diff(worktree);
        if (!diff.trim()) throw new Error("The result has no base-to-HEAD diff; refusing to mark a no-op task DONE");
        const dirty = await this.#options.worktrees.status(worktree);
        if (dirty) throw new Error("Worktree is still dirty after commit; refusing to mark DONE");
        // Archive all evidence before the irreversible DONE transition. The DB remains authoritative
        // if a crash occurs here; readReport overlays the live state when serving the artifact.
        await this.#writeReport(taskId, "done", { task, baseCommit, resultCommit, diff });
        this.#assertNotCancelled(active);
        this.#assertLease(taskId, owner, () => leaseLost);
        task = this.#options.store.transition(taskId, "reviewing", "done", { owner, clearLease: true, reason: "checks, review, commit, and report completed" });
        markedDone = true;
        return this.#requireTask(taskId);
      }
    } catch (error) {
      const cancelled = active.cancelRequested;
      errorMessage = cancelled ? "Cancelled by user" : errorText(error);
      const quotaFailure = error instanceof QuotaLimitError && !cancelled && !leaseLost;
      let executionStageFinalizationFailed = false;
      if (activeAttempt) {
        try {
          const linkedStage = activeAttempt.stageId ? this.#options.store.getStage(activeAttempt.stageId) : undefined;
          this.#options.store.finishAttempt(activeAttempt.id, {
            status: leaseLost || cancelled ? "interrupted" : "failed",
            error: errorMessage,
          }, linkedStage ? { owner, processStartId: linkedStage.processStartId } : undefined);
        } catch {
          if (activeAttempt.stageId) {
            try { this.#assertLease(taskId, owner, () => leaseLost); }
            catch { leaseLost = true; }
          }
        }
      }
      if (executionStage && !leaseLost && this.#options.store.getStage(executionStage.id)?.status === "running") {
        try {
          this.#assertLease(taskId, owner, () => leaseLost);
          finalizedExecutionFingerprint = await this.#finishExecutionStage({
            task, worktree: worktree!, stage: executionStage, attempt: executionAttempt, route: finalRoute!, owner,
            status: quotaFailure ? "interrupted" : cancelled ? "interrupted" : "failed",
            checks: executionChecks,
            summary: quotaFailure
              ? "Zero observed the execution stopped after a provider usage limit."
              : cancelled
                ? "Zero observed that the stage was cancelled."
                : "Zero observed that execution ended before all required gates succeeded.",
          });
          executionStage = undefined;
          executionAttempt = undefined;
        } catch (stageError) {
          executionStageFinalizationFailed = true;
          errorMessage = `Unable to finalize execution stage: ${errorText(stageError)}`;
          try { this.#assertLease(taskId, owner, () => leaseLost); }
          catch { leaseLost = true; }
        }
      }
      if (quotaFailure && !executionStageFinalizationFailed && !leaseLost && worktree && baseCommit) {
        try {
          this.#assertLease(taskId, owner, () => leaseLost);
          this.#assertAllowedPaths(task, await this.#options.worktrees.changedPaths(worktree));
          const checkpointFingerprint = await this.#worktreeFingerprint(worktree);
          if (finalizedExecutionFingerprint && finalizedExecutionFingerprint !== checkpointFingerprint) {
            throw new Error("Worktree changed after the interrupted execution stage was archived; quota resume is unsafe");
          }
          const checkpoint: WorkerCheckpoint = {
            version: 1,
            stage,
            baseCommit,
            worktreeFingerprint: checkpointFingerprint,
            revision,
            revisionBrief,
            ...(finalRoute ? { finalRoute } : {}),
            ...(stage === "review" ? { finalChecks } : {}),
          };
          const retryAt = quotaRetryAt(task.quotaRetryCount ?? 0, { source: error.retryAt ? "provider_message" : "fallback", retryAt: error.retryAt });
          task = this.#options.store.pauseForQuota(taskId, owner, { retryAt, checkpoint: { ...checkpoint }, reason: errorMessage,
            source: error.retryAt ? "provider_message" : "fallback" });
          try {
            await this.#writeReport(taskId, "waiting", { task, baseCommit, error: errorMessage, diff: await this.#options.worktrees.diff(worktree) });
          } catch { /* SQLite retains the waiting state and checkpoint. */ }
          return task;
        } catch (pauseError) {
          errorMessage = `Unable to preserve quota checkpoint: ${errorText(pauseError)}`;
        }
      }
      if (!leaseLost) {
        const current = this.#options.store.get(taskId);
        if (current && current.status !== "done" && current.status !== "failed" && current.leaseOwner === owner) {
          try { task = this.#options.store.fail(taskId, current.status, errorMessage, owner); } catch { /* preserve the original failure */ }
        }
      }
      if (!markedDone) {
        try {
          const diff = worktree ? await this.#options.worktrees.diff(worktree) : undefined;
          await this.#writeReport(taskId, "failed", { task: this.#options.store.get(taskId) ?? task, baseCommit, resultCommit, error: errorMessage, diff });
        } catch { /* the task failure remains in SQLite if artifact storage is unavailable */ }
      }
      return this.#options.store.get(taskId) ?? task;
    } finally {
      clearInterval(interval);
      this.#active.delete(taskId);
    }
  }

  /** Request cooperative cancellation of an active task. The worker records FAILED after stopping the current process. */
  async cancel(taskId: string): Promise<boolean> {
    const task = this.#options.store.get(taskId);
    if (!task || !["running", "reviewing", "revision"].includes(task.status)) return false;
    const active = this.#active.get(taskId);
    if (!active) return false;
    active.cancelRequested = true;
    active.controller.abort(new Error("Cancelled by user"));
    if (active.adapter && active.attempt) {
      try { await active.adapter.cancel?.(taskId, active.attempt.id); } catch { /* the worker still observes the abort flag */ }
    }
    return true;
  }

  #assertNotCancelled(active: { controller: AbortController; cancelRequested: boolean }): void {
    if (active.cancelRequested || active.controller.signal.aborted) throw new Error("Cancelled by user");
  }

  #validateRoute(task: TaskRecord, route: RouteDecision): void {
    if (route.taskId !== task.id || !route.harness || !route.model || !route.reason?.trim()) throw new Error("Router returned an incomplete or mismatched route");
    const selection = task.selection;
    if (selection?.harness && selection.harness !== route.harness) throw new Error("Router changed the task-pinned Harness");
    if (selection?.model && selection.model !== route.model) throw new Error("Router changed the task-pinned model");
    const effort = route.effectiveReasoningEffort ?? route.reasoningEffort;
    if (selection?.reasoningEffort && selection.reasoningEffort !== effort) throw new Error("Router changed the task-pinned reasoning effort");
    if (!route.selectionSource || !route.decidedAt) throw new Error("Router omitted selection source or decision time");
  }

  #assertAllowedPaths(task: TaskRecord, paths: string[]): void {
    const allowed = task.allowedPaths;
    if (!allowed?.length) return;
    const invalidPattern = allowed.find(pattern => !pattern || pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern) || pattern.replaceAll("\\", "/").split("/").includes(".."));
    if (invalidPattern) throw new Error(`Unsafe allowedPaths pattern: ${invalidPattern}`);
    const regexes = allowed.map(globRegex);
    const denied = paths.filter(path => !regexes.some(regex => regex.test(path)));
    if (denied.length) throw new Error(`Changed files outside allowedPaths: ${denied.join(", ")}`);
  }

  #revisionBrief(task: TaskRecord, failed: CheckResult[], review: ReviewResult | undefined, revision: number): string {
    const chunks = [task.prompt, `\n\nZero revision ${revision} requested. Preserve the original task and address all evidence below.`];
    if (failed.length) chunks.push(`Failed checks:\n${failed.map(item => `- ${item.id}: status=${item.status}; exitCode=${String(item.exitCode)}`).join("\n")}`);
    if (review) chunks.push(`Reviewer verdict: ${review.verdict}\n${review.summary}\n${review.findings.map(item => `- ${item.severity}${item.file ? ` ${item.file}${item.line ? `:${item.line}` : ""}` : ""}: ${item.evidence} Required change: ${item.requestedChange}`).join("\n")}`);
    if (task.acceptanceCriteria?.length) chunks.push(`Acceptance criteria:\n${task.acceptanceCriteria.map(item => `- ${item}`).join("\n")}`);
    return chunks.join("\n");
  }

  #assertLease(taskId: string, owner: string, lost: () => boolean): void {
    if (lost()) throw new Error("Task lease was lost; execution stopped without retrying external work");
    const task = this.#options.store.get(taskId);
    if (task?.leaseOwner !== owner || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= Date.now()) throw new Error("Task lease is no longer valid");
  }

  #artifactDirectory(taskId: string): string { return resolve(this.#options.artifactRoot, taskId); }

  async #worktreeFingerprint(worktree: WorktreeInfo): Promise<string> {
    return this.#options.worktrees.fingerprint(worktree);
  }

  async #finishExecutionStage(input: {
    task: TaskRecord;
    worktree: WorktreeInfo;
    stage: StageRecord | undefined;
    attempt: Attempt | undefined;
    route: RouteDecision;
    owner: string;
    status: Extract<StageStatus, "succeeded" | "failed" | "interrupted">;
    checks: CheckResult[];
    summary: string;
  }): Promise<string | undefined> {
    const { task, worktree, stage, attempt, route, owner, checks, summary } = input;
    if (!stage) throw new Error("Execution stage record is missing");
    this.#assertLease(task.id, owner, () => false);

    let fingerprint: string | undefined;
    let changedFiles: string[] | undefined;
    let workspaceState: HandoffV1["workspace"]["state"] = "unknown";
    let snapshotFailed = false;
    try {
      const statusBefore = await this.#options.worktrees.status(worktree);
      const pathsBefore = (await this.#options.worktrees.changedPaths(worktree)).sort();
      fingerprint = await this.#options.worktrees.fingerprint(worktree);
      const statusAfter = await this.#options.worktrees.status(worktree);
      const pathsAfter = (await this.#options.worktrees.changedPaths(worktree)).sort();
      if (statusBefore !== statusAfter || JSON.stringify(pathsBefore) !== JSON.stringify(pathsAfter)) {
        throw new Error("Worktree moved while building handoff snapshot");
      }
      if (pathsAfter.length > 40 || pathsAfter.some(path => path.length > 512)) {
        throw new Error("Changed path list exceeds the bounded handoff representation");
      }
      workspaceState = statusAfter ? "dirty" : "clean";
      changedFiles = pathsAfter;
    } catch {
      fingerprint = undefined;
      changedFiles = undefined;
      workspaceState = "unknown";
      snapshotFailed = true;
    }

    const finalStatus = input.status === "succeeded" && snapshotFailed ? "failed" : input.status;
    this.#options.store.finishStage(stage.id, owner, stage.processStartId, finalStatus, fingerprint);
    if (attempt) {
      const observedChecks = (task.checks ?? []).slice(0, 40).map(definition => {
        const result = checks.find(item => item.id === definition.id);
        return {
          id: definition.id.slice(0, 160),
          status: result === undefined ? "not_run" as const
            : result.status === "passed" ? "passed" as const
              : result.status === "timed_out" ? "timed_out" as const : "failed" as const,
          ...(result ? { evidence: `exitCode=${String(result.exitCode)}; durationMs=${result.durationMs}` } : { evidence: "not run" }),
        };
      });
      const risks = [
        ...(snapshotFailed ? ["Workspace snapshot is incomplete or exceeded the handoff path limits; inspect the archived task evidence."] : []),
        ...((task.checks?.length ?? 0) > 40 ? ["Only the first 40 configured checks fit the handoff schema; see the task report for all checks."] : []),
      ];
      const completed = [summary, ...observedChecks.filter(check => check.status === "passed").map(check => `Validation check passed: ${check.id}`)].slice(0, 40);
      const changed = changedFiles ?? [];
      const handoff: HandoffV1 = {
        schemaVersion: 1,
        taskId: task.id,
        stageId: stage.id,
        createdAt: new Date().toISOString(),
        source: {
          attemptId: attempt.id,
          harness: route.harness,
          model: route.model,
          ...(route.configHash ? { configHash: route.configHash } : {}),
          processStartId: stage.processStartId,
        },
        task: {
          objective: truncateWithReference(task.prompt, 8_000, task.id),
          acceptanceCriteria: boundedAcceptanceCriteria(task.acceptanceCriteria ?? [], task.id),
        },
        workspace: workspaceState === "unknown"
          ? { state: "unknown" }
          : { baseCommit: worktree.baseCommit, fingerprint: fingerprint!, state: workspaceState, changedFiles: changed },
        completed,
        currentState: summary,
        decisions: [],
        rejectedOptions: [],
        keyFiles: changed.slice(0, 20).map(path => ({ path, reason: "Git reports this path changed from the task base." })),
        checks: observedChecks,
        blockers: finalStatus === "succeeded" ? [] : ["Execution stage did not complete all required validation gates."],
        risks,
        nextSteps: finalStatus === "succeeded"
          ? ["Continue through Zero's review and task completion gates."]
          : ["Inspect the task report and worktree before starting another attempt."],
      };
      if (Buffer.byteLength(JSON.stringify(handoff), "utf8") > HANDOFF_V1_MAX_BYTES) {
        handoff.task.objective = taskRecordReference(task.id, "The original task objective is omitted from this handoff because of its payload size.");
        handoff.keyFiles = [];
        handoff.risks.push("The changed-file list may be truncated to keep this handoff within 64 KiB; the fingerprint covers the full worktree. Inspect the task record and report for complete evidence.");
        let boundedChangedFiles = handoff.workspace.state === "unknown" ? undefined : [...(handoff.workspace.changedFiles ?? [])];
        if (boundedChangedFiles) {
          boundedChangedFiles = boundedChangedFiles.slice(0, 20);
          handoff.workspace.changedFiles = boundedChangedFiles;
        }
        if (Buffer.byteLength(JSON.stringify(handoff), "utf8") > HANDOFF_V1_MAX_BYTES) {
          handoff.task.acceptanceCriteria = [taskRecordReference(task.id, "Full acceptance criteria are retained in the primary task record; omitted here because of the 64 KiB handoff payload limit.")];
        }
        while (Buffer.byteLength(JSON.stringify(handoff), "utf8") > HANDOFF_V1_MAX_BYTES
          && boundedChangedFiles && boundedChangedFiles.length > 0) {
          boundedChangedFiles = boundedChangedFiles.slice(0, Math.floor(boundedChangedFiles.length / 2));
          handoff.workspace.changedFiles = boundedChangedFiles;
        }
      }
      this.#options.store.saveHandoff(handoff);
    }
    if (input.status === "succeeded" && snapshotFailed) {
      throw new Error("Zero could not capture a complete output worktree snapshot for the execution stage");
    }
    return fingerprint;
  }

  async #writeReport(taskId: string, finalStatus: TaskReport["finalStatus"], values: {
    task: TaskRecord; baseCommit?: string; resultCommit?: string; error?: string; diff?: string;
  }): Promise<void> {
    const root = resolve(this.#options.artifactRoot);
    const directory = this.#artifactDirectory(taskId);
    const rel = relative(root, directory);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Report path escapes artifact root");
    await mkdir(directory, { recursive: true });
    const now = new Date().toISOString();
    let diffPath: string | undefined;
    if (values.diff !== undefined) {
      diffPath = resolve(directory, "result.diff");
      await writeFile(diffPath, values.diff, "utf8");
    }
    const report: TaskReport = {
      schemaVersion: 1,
      taskId,
      finalStatus,
      createdAt: values.task.createdAt,
      updatedAt: now,
      task: values.task,
      baseCommit: values.baseCommit,
      resultCommit: values.resultCommit,
      routeDecisions: this.#options.store.events(taskId).filter(event => event.type === "route.decided").map(event => event.payload?.decision as RouteDecision),
      attempts: this.#options.store.attempts(taskId),
      stages: this.#options.store.stages(taskId),
      handoffs: this.#options.store.handoffs(taskId),
      checks: this.#options.store.checks(taskId),
      reviews: this.#options.store.reviews(taskId),
      diffPath,
      error: values.error,
    };
    const temp = resolve(directory, `report.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temp, resolve(directory, "report.json"));
  }

  #requireTask(taskId: string): TaskRecord {
    const task = this.#options.store.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    return task;
  }

  /** Read an archived report with authoritative task state from SQLite overlaid. */
  async readReport(taskId: string): Promise<TaskReport | undefined> {
    const task = this.#options.store.get(taskId);
    if (!task) return undefined;
    try {
      const report = JSON.parse(await readFile(resolve(this.#artifactDirectory(taskId), "report.json"), "utf8")) as TaskReport;
      return {
        ...report,
        finalStatus: task.status,
        task,
        updatedAt: task.updatedAt,
        stages: report.stages ?? this.#options.store.stages(taskId),
        handoffs: report.handoffs ?? this.#options.store.handoffs(taskId),
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function taskRecordReference(taskId: string, message: string): string {
  return `${message} See primary Zero task record ${taskId}.`;
}

function truncateWithReference(value: string, limit: number, taskId: string): string {
  if (value.length <= limit) return value;
  const suffix = `\n\n[Truncated; see primary Zero task record ${taskId} for the full text.]`;
  return `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function boundedAcceptanceCriteria(criteria: string[], taskId: string): string[] {
  if (!criteria.length) return [];
  const omitted = criteria.length > 20;
  const values = criteria.slice(0, omitted ? 19 : 20)
    .map(item => truncateWithReference(item, 1_000, taskId));
  if (omitted) values.push(taskRecordReference(taskId, "Additional acceptance criteria were omitted;"));
  return values;
}

function parseCheckpoint(raw: Record<string, unknown> | undefined): WorkerCheckpoint | undefined {
  if (!raw) return undefined;
  if (raw.version !== 1 || !["route", "execute", "review"].includes(String(raw.stage))
    || typeof raw.baseCommit !== "string" || !/^[a-fA-F0-9]{40,64}$/.test(raw.baseCommit)
    || typeof raw.worktreeFingerprint !== "string" || !/^[a-fA-F0-9]{64}$/.test(raw.worktreeFingerprint)
    || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
    || typeof raw.revisionBrief !== "string" || !raw.revisionBrief.trim()) {
    throw new Error("Invalid quota resume checkpoint");
  }
  if (raw.finalRoute !== undefined && (!raw.finalRoute || typeof raw.finalRoute !== "object")) throw new Error("Invalid checkpoint route");
  if (raw.finalChecks !== undefined && !Array.isArray(raw.finalChecks)) throw new Error("Invalid checkpoint checks");
  return raw as unknown as WorkerCheckpoint;
}

function isReviewResult(value: ReviewResult): boolean {
  if (!value || !["pass", "changes_requested", "blocked"].includes(value.verdict)
    || typeof value.summary !== "string" || !value.summary.trim() || !Array.isArray(value.findings)) return false;
  const validFindings = value.findings.every(finding => Boolean(finding)
    && ["critical", "high", "medium", "low"].includes(finding.severity)
    && typeof finding.evidence === "string" && finding.evidence.trim().length > 0
    && typeof finding.requestedChange === "string" && finding.requestedChange.trim().length > 0
    && (finding.file === undefined || typeof finding.file === "string")
    && (finding.line === undefined || Number.isSafeInteger(finding.line)));
  return validFindings && (value.verdict !== "pass" || value.findings.length === 0)
    && (value.verdict !== "changes_requested" || value.findings.length > 0);
}

function globRegex(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let source = "^";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*" && normalized[i + 2] === "/") { source += "(?:.*/)?"; i += 2; }
      else if (normalized[i + 1] === "*") { source += ".*"; i++; }
      else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}
