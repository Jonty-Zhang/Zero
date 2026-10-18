import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { TaskSequenceRecord } from '../domain/types.js';
import type { GitWorktreeManager, WorktreeCreationEvidence, WorktreeCreationPlan } from '../core/git-worktree.js';
import type { TaskStore } from '../core/task-store.js';
import { createTrustedCodexCwd, createTrustedGoalCwd, safeGitEnvironment, worktreeGitEnvironment,
  type GoalProjectSource, type ProjectSnapshot } from '../orchestrator/trusted-codex-cwd.js';

const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_DIFF_BYTES = 192 * 1024;
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const identityKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const sameCommit = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
function block(reason: string): never { throw new Error(`GOAL_BLOCK:Aggregate goal verification is blocked because ${reason}.`); }

interface RepositoryGroup {
  repositoryId: string;
  commonGitDir: string;
  baseCommit: string;
  finalCommit: string;
  finalTree: string;
  finalPlan: WorktreeCreationPlan;
  finalObserved: WorktreeCreationEvidence;
  taskIds: string[];
}

/** Only authoritative committed task results can become independent aggregate-review input. */
export async function captureSequenceGoalEvidence(store: TaskStore, worktrees: GitWorktreeManager,
  sequence: TaskSequenceRecord, artifactRoot: string): Promise<{
    stepEvidence: unknown; workspacePath: string; repositories: GoalProjectSource[]; fingerprint: string; snapshotFingerprint: string;
  }> {
  if (sequence.steps.length < 2 || sequence.steps.some(step => step.task.status !== 'done')) block('every step must be authoritatively DONE');
  await mkdir(artifactRoot, { recursive: true });
  const configDir = await mkdtemp(join(resolve(artifactRoot), '.goal-git-'));
  const configPath = join(configDir, 'config');
  try {
    await writeFile(configPath, '', { mode: 0o600, flag: 'wx' });
    const env = safeGitEnvironment(configPath);
    const git = (cwd: string, args: string[], maxBuffer = 1024 * 1024, readEnv = env) => {
      const result = spawnSync('git', args, { cwd, env: readEnv, windowsHide: true, timeout: 15_000, maxBuffer });
      if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) block('Git evidence could not be safely read');
      return result.stdout!;
    };
    const gitText = (cwd: string, args: string[], readEnv = env) => git(cwd, args, 1024 * 1024, readEnv).toString('utf8').trim();
    const groups = new Map<string, RepositoryGroup>();
    const stepEvidence: Array<Record<string, unknown>> = [];
    for (const step of sequence.steps) {
      const task = step.task;
      const creation = store.getWorktreeCreation(task.id);
      const plan = creation?.plan as WorktreeCreationPlan | undefined;
      const observed = creation?.observed as WorktreeCreationEvidence | undefined;
      if (creation?.status !== 'created' || !plan || !observed?.info || plan.taskId !== task.id
        || ![plan.repoPath, plan.path, plan.worktreeRoot, plan.commonGitDir].every(path => typeof path === 'string' && isAbsolute(path))
        || plan.path !== resolve(plan.worktreeRoot, task.id) || plan.branch !== `zero/${task.id}`
        || typeof plan.baseCommit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(plan.baseCommit)
        || observed.info.taskId !== task.id || observed.info.repoPath !== plan.repoPath || observed.info.path !== plan.path
        || observed.info.branch !== plan.branch || observed.info.baseCommit !== plan.baseCommit
        || observed.commonGitDir !== plan.commonGitDir || !sameCommit(observed.head, plan.baseCommit)
        || creation.fingerprint !== observed.fingerprint || !/^[a-f0-9]{64}$/.test(observed.fingerprint)) block('registered task worktree creation evidence is missing or inconsistent');
      const canonicalRepo = await realpath(gitText(task.repoPath, ['rev-parse', '--show-toplevel']));
      const commonGitDir = await realpath(gitText(task.repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      if (identityKey(canonicalRepo) !== identityKey(plan.repoPath) || identityKey(commonGitDir) !== identityKey(plan.commonGitDir)) block('repository identity changed since task creation');

      const reports = store.reportOperations(task.id);
      const commits = store.commitOperations(task.id).filter(commit => commit.status === 'applied');
      if (reports.length !== 1 || reports[0]!.status !== 'complete' || commits.length !== 1
        || reports[0]!.commitOperationId !== commits[0]!.id || !commits[0]!.candidateSha) block('a completed step lacks authoritative report and commit evidence');
      const report = reports[0]!; const commit = commits[0]!;
      const pkg = store.getReviewPackage(commit.packageId);
      const run = pkg && store.getCheckRun(pkg.checkRunId);
      if (!pkg || !run || pkg.taskId !== task.id || run.taskId !== task.id || run.id !== pkg.checkRunId
        || run.status !== 'completed' || report.packageId !== pkg.id || report.verdictId !== commit.verdictId
        || pkg.executionAttemptId !== run.executionAttemptId || pkg.executionStageId !== run.executionStageId
        || pkg.routeAttemptId !== run.routeAttemptId || pkg.checkDefinitionHash !== run.checkDefinitionHash
        || JSON.stringify(pkg.expectedCheckIds) !== JSON.stringify(run.expectedCheckIds)
        || pkg.branchRef !== commit.branchRef || pkg.snapshot.preHead !== commit.preHead
        || pkg.snapshot.treeId !== commit.treeId || pkg.snapshot.diffHash !== commit.diffHash
        || JSON.stringify(pkg.snapshot) !== JSON.stringify(run.snapshot)
        || !sameCommit(pkg.snapshot.baseCommit, plan.baseCommit)) block('the completed result lacks its linked current check package and registered base');
      const completedEvent = store.events(task.id).find(event => event.type === 'check_run.completed'
        && event.payload?.checkRunId === run!.id && event.payload?.reviewPackageId === pkg!.id);
      const results = store.checkRunResults(run.id);
      const ids = new Set(results.map(result => result.id));
      if (!Array.isArray(completedEvent?.payload?.results) || JSON.stringify(completedEvent.payload.results) !== JSON.stringify(results)
        || results.length !== run.expectedCheckIds.length || ids.size !== run.expectedCheckIds.length
        || run.expectedCheckIds.some(id => !ids.has(id)) || results.some(result => result.status !== 'passed')) block('persisted current check evidence is incomplete');

      const key = identityKey(commonGitDir);
      let group = groups.get(key);
      if (group) {
        if (!sameCommit(step.effectiveBaseCommit, group.finalCommit) || !sameCommit(plan.baseCommit, group.finalCommit)
          || !sameCommit(task.sequenceBaseCommit, group.finalCommit)) block('repository-group commits do not match their persisted handoff bases');
        group.finalCommit = commit.candidateSha!; group.finalTree = commit.treeId;
        group.finalPlan = plan; group.finalObserved = observed; group.taskIds.push(task.id);
      } else {
        if (groups.size >= 20) block('the repository count exceeds the bounded review limit');
        if ((step.effectiveBaseCommit && !sameCommit(step.effectiveBaseCommit, plan.baseCommit))
          || (task.sequenceBaseCommit && !sameCommit(task.sequenceBaseCommit, plan.baseCommit))) block('a registered base disagrees with its persisted handoff');
        group = { repositoryId: `repo-${groups.size + 1}`, commonGitDir, baseCommit: plan.baseCommit,
          finalCommit: commit.candidateSha!, finalTree: commit.treeId, finalPlan: plan, finalObserved: observed, taskIds: [task.id] };
        groups.set(key, group);
      }
      stepEvidence.push({ position: step.position, taskId: task.id, repositoryId: group.repositoryId, prompt: task.prompt,
        acceptanceCriteria: task.acceptanceCriteria ?? [], baseRef: task.baseRef, effectiveBaseCommit: step.effectiveBaseCommit,
        resultCommit: commit.candidateSha,
        report: { reportSha256: report.reportSha256, reportSize: report.reportSize, diffSha256: report.diffSha256, diffSize: report.diffSize },
        checks: [{ runId: run.id, status: run.status, expectedCheckIds: run.expectedCheckIds, checkDefinitionHash: run.checkDefinitionHash,
          snapshot: { baseCommit: run.snapshot.baseCommit, preHead: run.snapshot.preHead, treeId: run.snapshot.treeId,
            fingerprint: run.snapshot.fingerprint, diffHash: run.snapshot.diffHash },
          results: results.map(({ id, status, exitCode, durationMs }) => ({ id, status, exitCode, durationMs })) }] });
    }

    const repositories: GoalProjectSource[] = [];
    const repositoryEvidence: Array<Record<string, unknown>> = [];
    let diffBytes = 0;
    for (const group of groups.values()) {
      const { env: readEnv, textNormalization } = await worktreeGitEnvironment(configPath, group.finalPlan.path);
      let workspace;
      try { workspace = (await worktrees.reopenFromEvidence(group.finalPlan, group.finalObserved, readEnv)).info; }
      catch { block('the final reviewed worktree cannot be safely reopened'); }
      const head = gitText(workspace.path, ['rev-parse', '--verify', 'HEAD^{commit}'], readEnv);
      const index = gitText(workspace.path, ['write-tree'], readEnv);
      if (!sameCommit(head, group.finalCommit) || !sameCommit(index, group.finalTree)) block('a final worktree HEAD or index changed after its task was marked DONE');
      if (git(workspace.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 1024 * 1024, readEnv).byteLength) block('a final worktree has changes after its task was marked DONE');
      const bytes = git(workspace.path, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', group.baseCommit, group.finalCommit, '--'], MAX_DIFF_BYTES - diffBytes + 1, readEnv);
      diffBytes += bytes.byteLength;
      if (diffBytes > MAX_DIFF_BYTES) block('the combined cumulative diffs exceed the bounded review limit');
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) block('a cumulative diff is not valid UTF-8 evidence');
      repositories.push({ repositoryId: group.repositoryId, targetTaskId: group.finalPlan.taskId, taskWorkspace: workspace.path });
      repositoryEvidence.push({ repositoryId: group.repositoryId, targetTaskId: group.finalPlan.taskId, taskIds: group.taskIds,
        baseCommit: group.baseCommit, finalResultCommit: group.finalCommit, cumulativeDiff: { sha256: sha(text), text }, finalWorktreeHead: head, gitTextNormalization: textNormalization });
    }
    let snapshotFingerprint: string;
    let evidence: Record<string, unknown>;
    if (repositories.length === 1) {
      const trusted = await createTrustedCodexCwd({ artifactRoot, purpose: 'review', taskWorkspace: repositories[0]!.taskWorkspace, includeProjectSnapshot: true });
      try {
        if (!trusted.projectSnapshot) block('a final project snapshot could not be created');
        snapshotFingerprint = trusted.projectSnapshot.manifest.contentSha256;
        // Preserve the legacy single-repository evidence shape and cache contract.
        const { repositoryId: _id, targetTaskId: _target, taskIds: _tasks, ...legacy } = repositoryEvidence[0]!;
        evidence = { objective: sequence.objective ?? '', acceptanceCriteria: sequence.acceptanceCriteria ?? [],
          steps: stepEvidence.map(({ repositoryId: _repo, ...step }) => step), ...legacy,
          projectSnapshot: snapshotMetadata(trusted.projectSnapshot) };
      } finally { await trusted.dispose(); }
    } else {
      const trusted = await createTrustedGoalCwd({ artifactRoot, repositories });
      try {
        snapshotFingerprint = trusted.contentSha256;
        evidence = { objective: sequence.objective ?? '', acceptanceCriteria: sequence.acceptanceCriteria ?? [], steps: stepEvidence,
          repositories: repositoryEvidence.map((repo, index) => ({ ...repo, projectSnapshot: snapshotMetadata(trusted.projectSnapshots[index]!.snapshot) })) };
      } finally { await trusted.dispose(); }
    }
    const serialized = JSON.stringify(evidence);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) block('its persisted evidence exceeds the bounded review limit');
    return { stepEvidence: evidence, workspacePath: repositories[0]!.taskWorkspace, repositories,
      fingerprint: sha(serialized), snapshotFingerprint };
  } finally {
    await rm(configPath, { force: true });
    await rmdir(configDir);
  }
}

function snapshotMetadata(snapshot: ProjectSnapshot) {
  const { headCommit, indexTree, contentSha256, fileCount, totalBytes, excluded, transformed } = snapshot.manifest;
  return { headCommit, indexTree, contentSha256, fileCount, totalBytes, excluded, transformed };
}
