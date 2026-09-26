import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, lstat, readFile, readlink, realpath, rm, mkdtemp } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);
export const WORKTREE_FINGERPRINT_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const WORKTREE_FINGERPRINT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const WORKTREE_FINGERPRINT_MAX_PATHS = 100_000;
const GIT_METADATA_MAX_BYTES = 16 * 1024 * 1024;

export interface WorktreeInfo {
  taskId: string;
  repoPath: string;
  path: string;
  branch: string;
  baseCommit: string;
}

/** Canonical, serializable inputs recorded before `git worktree add` can mutate Git state. */
export interface WorktreeCreationPlan {
  taskId: string;
  repoPath: string;
  commonGitDir: string;
  worktreeRoot: string;
  path: string;
  branch: string;
  baseCommit: string;
}

/** Observed identity persisted only after Git has created and registered the worktree. */
export interface WorktreeCreationEvidence {
  info: WorktreeInfo;
  commonGitDir: string;
  head: string;
  fingerprint: string;
}

/** Immutable, staged tree and complete patch that a reviewer approved. */
export interface WorktreeReviewSnapshot {
  fingerprint: string;
  diff: string;
  diffHash: string;
  treeId: string;
}

export interface ReviewedCommitMetadata {
  /** Stable id for the logical operation, also recorded as a commit trailer. */
  opId: string;
  message: string;
  /** Git date accepted by Git, for example `2026-09-26T12:00:00+08:00`. */
  timestamp: string;
}

export interface ReviewedCommitCandidate {
  branchRef: string;
  preHead: string;
  commit: string;
  treeId: string;
  diffHash: string;
  opId: string;
}

export class GitWorktreeManager {
  readonly #root: string;

  constructor(worktreeRoot: string) { this.#root = resolve(worktreeRoot); }

  async exists(taskId: string): Promise<boolean> {
    this.#assertTaskId(taskId);
    await mkdir(this.#root, { recursive: true });
    const root = await realpath(this.#root);
    const path = resolve(root, taskId);
    this.#assertInside(root, path);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink at task worktree path: ${path}`);
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async prepareCreatePlan(taskId: string, repoPath: string, baseRef: string): Promise<WorktreeCreationPlan> {
    this.#assertTaskId(taskId);
    if (!baseRef || baseRef.startsWith("-")) throw new Error("Invalid baseRef");
    const repo = await realpath(repoPath);
    const { stdout: repoTop } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, windowsHide: true });
    const canonicalRepo = await realpath(repoTop.trim());
    const { stdout: commonOutput } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: canonicalRepo, windowsHide: true });
    const commonGitDir = await realpath(commonOutput.trim());
    const { stdout: baseOutput } = await execFileAsync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: canonicalRepo, windowsHide: true });
    const baseCommit = baseOutput.trim();
    await mkdir(this.#root, { recursive: true });
    const safeRoot = await realpath(this.#root);
    const path = resolve(safeRoot, taskId);
    this.#assertInside(safeRoot, path);
    const branch = `zero/${taskId}`;
    const plan = { taskId, repoPath: canonicalRepo, commonGitDir, worktreeRoot: safeRoot, path, branch, baseCommit };
    await this.#revalidateCreationPlan(plan);
    return plan;
  }

  /** Rechecks every persisted identity before the first Git mutation, then captures observed creation evidence. */
  async executePlan(plan: WorktreeCreationPlan): Promise<WorktreeCreationEvidence> {
    await this.#revalidateCreationPlan(plan);
    await execFileAsync("git", ["worktree", "add", "-b", plan.branch, plan.path, plan.baseCommit], {
      cwd: plan.repoPath, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    const info: WorktreeInfo = {
      taskId: plan.taskId, repoPath: plan.repoPath, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit,
    };
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    const [headResult, commonResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: plan.path, windowsHide: true }),
      execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: plan.path, windowsHide: true }),
    ]);
    const head = headResult.stdout.trim();
    const commonGitDir = await realpath(commonResult.stdout.trim());
    if (head !== plan.baseCommit) throw new Error("Created worktree HEAD does not match its planned base commit");
    if (commonGitDir !== plan.commonGitDir) throw new Error("Created worktree belongs to a different Git common directory");
    const fingerprint = await this.fingerprint(info);
    return { info, commonGitDir, head, fingerprint };
  }

  async create(taskId: string, repoPath: string, baseRef: string): Promise<WorktreeInfo> {
    return (await this.executePlan(await this.prepareCreatePlan(taskId, repoPath, baseRef))).info;
  }

  /** Reopen only a task worktree that is still registered with the expected repository and branch. */
  async reopen(taskId: string, repoPath: string, baseCommit: string): Promise<WorktreeInfo> {
    this.#assertTaskId(taskId);
    if (!/^[a-fA-F0-9]{40,64}$/.test(baseCommit)) throw new Error("Invalid checkpoint base commit");
    const root = await realpath(this.#root);
    const path = resolve(root, taskId);
    this.#assertInside(root, path);
    if (await realpath(path) !== path) throw new Error("Task worktree path changed since quota pause");
    const repo = await realpath(repoPath);
    const { stdout: repoTop } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, windowsHide: true });
    const canonicalRepo = await realpath(repoTop.trim());
    const { stdout: worktreeTop } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: path, windowsHide: true });
    if (await realpath(worktreeTop.trim()) !== path) throw new Error("Checkpoint path is not the task worktree");
    const [repoCommon, worktreeCommon] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: canonicalRepo, windowsHide: true }),
      execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path, windowsHide: true }),
    ]);
    if (await realpath(repoCommon.stdout.trim()) !== await realpath(worktreeCommon.stdout.trim())) {
      throw new Error("Checkpoint worktree belongs to a different repository");
    }
    const info = { taskId, repoPath: canonicalRepo, path, branch: `zero/${taskId}`, baseCommit };
    await this.#ensureTaskBranch(info);
    const { stdout: commit } = await execFileAsync("git", ["rev-parse", "--verify", `${baseCommit}^{commit}`], { cwd: path, windowsHide: true });
    if (commit.trim().toLowerCase() !== baseCommit.toLowerCase()) throw new Error("Checkpoint base commit is missing");
    await execFileAsync("git", ["merge-base", "--is-ancestor", baseCommit, "HEAD"], { cwd: path, windowsHide: true });
    return info;
  }

  /**
   * Reopens a task worktree from its persisted creation plan and observed evidence.
   * The original fingerprint is validated as evidence metadata, then a fresh one
   * is computed after Git identity and ancestry have been checked.
   */
  async reopenFromEvidence(plan: WorktreeCreationPlan, evidence: WorktreeCreationEvidence): Promise<WorktreeCreationEvidence> {
    this.#assertTaskId(plan.taskId);
    if (!evidence || !evidence.info || !/^[a-f0-9]{64}$/.test(evidence.fingerprint)
      || !/^[a-fA-F0-9]{40,64}$/.test(evidence.head)) {
      throw new Error("Invalid persisted worktree creation evidence");
    }
    if (evidence.info.taskId !== plan.taskId || evidence.info.repoPath !== plan.repoPath
      || evidence.info.path !== plan.path || evidence.info.branch !== plan.branch
      || evidence.info.baseCommit !== plan.baseCommit || evidence.commonGitDir !== plan.commonGitDir
      || evidence.head.toLowerCase() !== plan.baseCommit.toLowerCase()) {
      throw new Error("Persisted worktree evidence does not match its creation plan");
    }
    if (plan.branch !== `zero/${plan.taskId}` || !/^[a-fA-F0-9]{40,64}$/.test(plan.baseCommit)) {
      throw new Error("Invalid persisted worktree creation plan");
    }

    const root = await realpath(this.#root);
    if (root !== plan.worktreeRoot || root !== this.#root) throw new Error("Worktree root changed since creation");
    const rootStat = await lstat(this.#root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Refusing symlink or non-directory worktree root");
    const path = resolve(root, plan.taskId);
    this.#assertInside(root, plan.path);
    if (plan.path !== path) throw new Error("Worktree path does not match its planned task id");
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) throw new Error("Refusing symlink or non-directory task worktree path");
    if (await realpath(path) !== plan.path) throw new Error("Task worktree path changed since creation");
    const dotGitStat = await lstat(resolve(path, ".git"));
    if (dotGitStat.isSymbolicLink() || !dotGitStat.isFile()) throw new Error("Task worktree Git metadata is not a regular linked-worktree file");

    const repo = await realpath(plan.repoPath);
    if (repo !== plan.repoPath) throw new Error("Repository path changed since creation");
    const { stdout: repoTop } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, windowsHide: true });
    if (await realpath(repoTop.trim()) !== plan.repoPath) throw new Error("Repository identity changed since creation");
    const { stdout: commonOutput } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, windowsHide: true });
    const commonGitDir = await realpath(commonOutput.trim());
    if (commonGitDir !== plan.commonGitDir) throw new Error("Repository Git common directory changed since creation");

    const [worktreeTop, worktreeCommon, headResult, baseResult, registeredResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: path, windowsHide: true }),
      execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path, windowsHide: true }),
      execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: path, windowsHide: true }),
      execFileAsync("git", ["rev-parse", "--verify", `${plan.baseCommit}^{commit}`], { cwd: repo, windowsHide: true }),
      execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: repo, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }),
    ]);
    if (await realpath(worktreeTop.stdout.trim()) !== plan.path) throw new Error("Checkpoint path is not the planned task worktree");
    if (await realpath(worktreeCommon.stdout.trim()) !== plan.commonGitDir) throw new Error("Checkpoint worktree belongs to a different Git common directory");
    if (baseResult.stdout.trim().toLowerCase() !== plan.baseCommit.toLowerCase()) throw new Error("Planned base commit is missing");
    const head = headResult.stdout.trim();
    if (!/^[a-fA-F0-9]{40,64}$/.test(head)) throw new Error("Git returned an invalid task worktree HEAD");

    const entries = parseWorktreePorcelain(registeredResult.stdout);
    const pathEntries = entries.filter(entry => entry.worktree && resolve(entry.worktree) === plan.path);
    const branchEntries = entries.filter(entry => entry.branch === `refs/heads/${plan.branch}`);
    if (pathEntries.length !== 1 || branchEntries.length !== 1 || pathEntries[0] !== branchEntries[0]) {
      throw new Error("Git worktree registration is missing, ambiguous, or has an unexpected branch identity");
    }
    const registered = pathEntries[0]!;
    if (registered.head?.toLowerCase() !== head.toLowerCase() || registered.detached || registered.bare || registered.prunable) {
      throw new Error("Git worktree registration does not match the task worktree HEAD and branch");
    }
    await execFileAsync("git", ["merge-base", "--is-ancestor", plan.baseCommit, head], { cwd: path, windowsHide: true });

    const info: WorktreeInfo = {
      taskId: plan.taskId, repoPath: plan.repoPath, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit,
    };
    const fingerprint = await this.fingerprint(info);
    const { stdout: finalHead } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: path, windowsHide: true });
    if (finalHead.trim().toLowerCase() !== head.toLowerCase()) {
      throw new Error("Task worktree HEAD changed while reopening from persisted evidence");
    }
    return { info, commonGitDir: plan.commonGitDir, head, fingerprint };
  }

  async diff(info: WorktreeInfo): Promise<string> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    const { stdout: tracked } = await execFileAsync("git", ["diff", "--no-ext-diff", "--binary", info.baseCommit, "--"], { cwd: info.path, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const { stdout: names } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: info.path, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const extra: string[] = [];
    for (const name of names.split("\0").filter(Boolean)) {
      const file = resolve(info.path, name);
      this.#assertInside(info.path, file);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) {
        extra.push(`diff --git a/${name} b/${name}\nnew file mode 120000\n--- /dev/null\n+++ b/${name}\n+${await readlink(file)}\n`);
        continue;
      }
      if (!stat.isFile()) { extra.push(`Untracked non-file omitted from text diff: ${name}\n`); continue; }
      const data = await readFile(file);
      if (data.includes(0)) extra.push(`Binary untracked file: ${name} (${data.length} bytes)\n`);
      else extra.push(`diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n${data.toString("utf8").split(/(?<=\n)/).map(line => `+${line}`).join("")}`);
    }
    return tracked + extra.join("");
  }

  async status(info: WorktreeInfo): Promise<string> {
    await this.#validateInfo(info);
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: info.path, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }

  /** Stage the current task output and capture the exact tree/diff the reviewer will see. */
  async prepareReview(info: WorktreeInfo): Promise<WorktreeReviewSnapshot> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    await execFileAsync("git", ["-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync", "add", "-A"], { cwd: info.path, windowsHide: true });
    return this.captureReviewSnapshot(info);
  }

  /** Capture a stable staged tree and canonical base-to-tree patch without modifying the index. */
  async captureReviewSnapshot(info: WorktreeInfo): Promise<WorktreeReviewSnapshot> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    await this.#assertNoUnstagedChanges(info);
    const fingerprintBefore = await this.fingerprint(info);
    const treeBefore = await this.#writeTree(info);
    const diff = await this.#diffTree(info, treeBefore);
    const diffHash = hash(diff);
    const fingerprintAfter = await this.fingerprint(info);
    const treeAfter = await this.#writeTree(info);
    let cleanAfter = true;
    try { await this.#assertNoUnstagedChanges(info); }
    catch { cleanAfter = false; }
    if (!cleanAfter || fingerprintBefore !== fingerprintAfter || treeBefore !== treeAfter) {
      throw new Error("Worktree changed while capturing the staged review snapshot");
    }
    return { fingerprint: fingerprintAfter, diff, diffHash, treeId: treeAfter };
  }

  /** Capture the same review tree as prepareReview without changing the real index. */
  async captureReviewSnapshotWithUnstaged(info: WorktreeInfo): Promise<WorktreeReviewSnapshot> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    const { stdout: indexOutput } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
      cwd: info.path, windowsHide: true,
    });
    const indexPath = resolve(info.path, indexOutput.trim());
    const temporaryDirectory = await mkdtemp(join(dirname(indexPath), "zero-review-index-"));
    const temporaryIndex = join(temporaryDirectory, "index");
    try {
      await copyFile(indexPath, temporaryIndex);
      const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
      const fingerprintBefore = await this.fingerprint(info);
      await execFileAsync("git", ["-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync", "add", "-A"], {
        cwd: info.path, windowsHide: true, env,
      });
      const treeBefore = await this.#writeTree(info, env);
      const diff = await this.#diffTree(info, treeBefore);
      const diffHash = hash(diff);
      const fingerprintAfterFirstStage = await this.fingerprint(info);
      await execFileAsync("git", ["-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync", "add", "-A"], {
        cwd: info.path, windowsHide: true, env,
      });
      const treeAfter = await this.#writeTree(info, env);
      const fingerprintAfter = await this.fingerprint(info);
      if (fingerprintBefore !== fingerprintAfterFirstStage || fingerprintBefore !== fingerprintAfter || treeBefore !== treeAfter) {
        throw new Error("Worktree changed while capturing a read-only review snapshot");
      }
      return { fingerprint: fingerprintAfter, diff, diffHash, treeId: treeAfter };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Fingerprints Git identity/index state plus content of every changed tracked
   * and non-ignored untracked file. Resource or path-boundary violations fail closed.
   */
  async fingerprint(info: WorktreeInfo): Promise<string> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    const readMetadata = async () => {
      const [headResult, indexResult, statusResult, changedResult, untrackedResult, flagResult] = await Promise.all([
        execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: info.path, windowsHide: true }),
        execFileAsync("git", ["ls-files", "--stage", "-z"], { cwd: info.path, windowsHide: true, maxBuffer: GIT_METADATA_MAX_BYTES }),
        execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: info.path, windowsHide: true, maxBuffer: GIT_METADATA_MAX_BYTES }),
        execFileAsync("git", ["diff", "--no-renames", "--name-only", "-z", info.baseCommit, "--"], { cwd: info.path, windowsHide: true, maxBuffer: GIT_METADATA_MAX_BYTES }),
        execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: info.path, windowsHide: true, maxBuffer: GIT_METADATA_MAX_BYTES }),
        execFileAsync("git", ["ls-files", "-v", "-z"], { cwd: info.path, windowsHide: true, maxBuffer: GIT_METADATA_MAX_BYTES }),
      ]);
      for (const entry of flagResult.stdout.split("\0").filter(Boolean)) {
        const tag = entry[0];
        if (tag === "S" || tag === "s" || (tag !== undefined && tag >= "a" && tag <= "z")) {
          throw new Error(`Cannot fingerprint index entry with assume-unchanged or skip-worktree flag: ${entry.slice(2)}`);
        }
      }
      return {
        head: headResult.stdout.trim(),
        index: indexResult.stdout,
        status: statusResult.stdout,
        changed: changedResult.stdout,
        untracked: untrackedResult.stdout,
        flags: flagResult.stdout,
      };
    };
    const metadata = await readMetadata();
    const trackedPaths = [...new Set(metadata.changed.split("\0").filter(Boolean))].sort();
    const untrackedPaths = [...new Set(metadata.untracked.split("\0").filter(Boolean))].sort();
    if (trackedPaths.length + untrackedPaths.length > WORKTREE_FINGERPRINT_MAX_PATHS) {
      throw new Error(`Worktree fingerprint exceeds ${WORKTREE_FINGERPRINT_MAX_PATHS} changed paths`);
    }

    const digest = createHash("sha256");
    const add = (label: string, value: string | Buffer): void => {
      digest.update(label);
      digest.update("\0");
      digest.update(value);
      digest.update("\0");
    };
    add("head", metadata.head);
    add("base", info.baseCommit);
    add("index", metadata.index);
    add("index-flags", metadata.flags);
    add("status", metadata.status);

    let totalBytes = 0;
    const observations: Array<{ path: string; kind: "missing" | "symlink" | "file"; linkTarget?: string; mode?: number; size?: number; mtimeMs?: number; ctimeMs?: number }> = [];
    const contents = [
      ...trackedPaths.map(path => ({ path, kind: "tracked" })),
      ...untrackedPaths.map(path => ({ path, kind: "untracked" })),
    ];
    for (const entry of contents) {
      const file = await this.#safeWorktreePath(info.path, entry.path);
      let stat;
      try { stat = await lstat(file); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          add("path", JSON.stringify([entry.kind, entry.path, "missing"]));
          observations.push({ path: entry.path, kind: "missing" });
          continue;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        const linkTarget = await readlink(file);
        add("path", JSON.stringify([entry.kind, entry.path, "symlink", linkTarget]));
        observations.push({ path: entry.path, kind: "symlink", linkTarget });
        continue;
      }
      if (!stat.isFile()) throw new Error(`Cannot fingerprint changed non-file path: ${entry.path}`);
      if (stat.size > WORKTREE_FINGERPRINT_MAX_FILE_BYTES) {
        throw new Error(`Cannot fingerprint ${entry.path}: file exceeds ${WORKTREE_FINGERPRINT_MAX_FILE_BYTES} byte limit`);
      }
      const canonicalFile = await realpath(file);
      this.#assertInside(info.path, canonicalFile);
      totalBytes += stat.size;
      if (totalBytes > WORKTREE_FINGERPRINT_MAX_TOTAL_BYTES) {
        throw new Error(`Cannot fingerprint worktree: changed-file content exceeds ${WORKTREE_FINGERPRINT_MAX_TOTAL_BYTES} byte total limit`);
      }
      add("file", JSON.stringify([entry.kind, entry.path, stat.mode & 0o777, stat.size]));
      let bytesRead = 0;
      const stream = createReadStream(canonicalFile, { flags: "r" });
      for await (const chunk of stream) {
        const data = chunk as Buffer;
        bytesRead += data.length;
        if (bytesRead > WORKTREE_FINGERPRINT_MAX_FILE_BYTES || totalBytes - stat.size + bytesRead > WORKTREE_FINGERPRINT_MAX_TOTAL_BYTES) {
          stream.destroy();
          throw new Error(`Cannot fingerprint ${entry.path}: file or total content limit exceeded while reading`);
        }
        digest.update(data);
      }
      const after = await lstat(file);
      if (!after.isFile() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || bytesRead !== stat.size) {
        throw new Error(`Cannot fingerprint ${entry.path}: file changed while being read`);
      }
      observations.push({ path: entry.path, kind: "file", mode: stat.mode & 0o777, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
      digest.update("\0");
    }
    const finalMetadata = await readMetadata();
    if (JSON.stringify(finalMetadata) !== JSON.stringify(metadata)) {
      throw new Error("Cannot fingerprint worktree: Git HEAD, index, status, or changed paths moved during capture");
    }
    for (const observation of observations) {
      const file = await this.#safeWorktreePath(info.path, observation.path);
      let stat;
      try { stat = await lstat(file); }
      catch (error) {
        if (observation.kind === "missing" && error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        throw new Error(`Cannot fingerprint worktree: ${observation.path} changed during capture`);
      }
      if (observation.kind === "missing"
        || (observation.kind === "symlink" && (!stat.isSymbolicLink() || await readlink(file) !== observation.linkTarget))
        || (observation.kind === "file" && (!stat.isFile() || (stat.mode & 0o777) !== observation.mode || stat.size !== observation.size || stat.mtimeMs !== observation.mtimeMs || stat.ctimeMs !== observation.ctimeMs))) {
        throw new Error(`Cannot fingerprint worktree: ${observation.path} changed during capture`);
      }
      if (observation.kind === "file") this.#assertInside(info.path, await realpath(file));
    }
    return digest.digest("hex");
  }

  async changedPaths(info: WorktreeInfo): Promise<string[]> {
    await this.#ensureTaskBranch(info);
    const [committed, staged] = await Promise.all([
      execFileAsync("git", ["diff", "--name-status", "-z", info.baseCommit, "HEAD", "--"], { cwd: info.path, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }),
      execFileAsync("git", ["diff", "--cached", "--name-status", "-z", "HEAD", "--"], { cwd: info.path, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }),
    ]);
    const committedPaths = [...readNameStatusPaths(committed.stdout), ...readNameStatusPaths(staged.stdout)];
    const status = await this.status(info);
    const chunks = status.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const entry = chunks[i]!;
      const path = entry.slice(3);
      if (path) paths.push(path.replaceAll("\\", "/"));
      // Porcelain v1 -z lists the destination path separately for renames/copies.
      if (/^[RC]./.test(entry.slice(0, 2)) && chunks[i + 1]) paths.push(chunks[++i]!.replaceAll("\\", "/"));
    }
    return [...new Set([...committedPaths, ...paths])];
  }

  async commit(info: WorktreeInfo, message: string, reviewed: WorktreeReviewSnapshot): Promise<string | undefined> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    assertReviewSnapshot(reviewed);
    await this.#assertMatchesReview(info, reviewed, "before commit");

    const headTree = await this.#headTree(info);
    if (headTree !== reviewed.treeId) {
      await execFileAsync("git", ["-c", "user.name=Zero", "-c", "user.email=zero@localhost", "commit", "-m", message], { cwd: info.path, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    }

    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: info.path, windowsHide: true });
    const head = stdout.trim();
    const committedTree = await this.#headTree(info);
    const committedDiff = await this.#diffCommit(info, head);
    if (committedTree !== reviewed.treeId || hash(committedDiff) !== reviewed.diffHash) {
      throw new Error("Committed tree does not match the reviewed worktree snapshot");
    }
    if (await this.status(info)) throw new Error("Worktree changed while verifying the reviewed commit");
    if (head === info.baseCommit || !committedDiff.trim()) return undefined;
    return head;
  }

  /** Read the exact task branch ref and its current commit without changing Git state. */
  async readTaskBranchHead(info: WorktreeInfo): Promise<{ ref: string; head: string }> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    const ref = `refs/heads/${info.branch}`;
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: info.path, windowsHide: true });
    const head = stdout.trim();
    if (!/^[a-fA-F0-9]{40,64}$/.test(head)) throw new Error("Git returned an invalid task branch HEAD");
    return { ref, head };
  }

  /**
   * Create a deterministic reviewed commit object without moving the task ref.
   * The caller must persist the returned candidate before applying it.
   */
  async createReviewedCommitCandidate(
    info: WorktreeInfo,
    preHead: string,
    reviewed: WorktreeReviewSnapshot,
    metadata: ReviewedCommitMetadata,
  ): Promise<ReviewedCommitCandidate> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    assertReviewSnapshot(reviewed);
    assertCommitMetadata(metadata);
    if (!/^[a-fA-F0-9]{40,64}$/.test(preHead)) throw new Error("Invalid candidate pre-HEAD");
    const { ref, head } = await this.readTaskBranchHead(info);
    if (head.toLowerCase() !== preHead.toLowerCase()) throw new Error("Task branch changed before candidate creation");
    const worktreeHead = await this.#head(info);
    if (worktreeHead.toLowerCase() !== preHead.toLowerCase()) throw new Error("Task worktree HEAD does not match candidate pre-HEAD");
    await execFileAsync("git", ["merge-base", "--is-ancestor", info.baseCommit, preHead], { cwd: info.path, windowsHide: true });
    await this.#assertMatchesReview(info, reviewed, "before candidate creation");
    const diff = await this.#diffTree(info, reviewed.treeId);
    if (hash(diff) !== reviewed.diffHash) throw new Error("Reviewed tree diff does not match the reviewed snapshot");
    if (!diff.trim()) {
      throw new Error("Refusing to create a commit for an empty reviewed change");
    }

    if ((await this.#headTree(info)).toLowerCase() === reviewed.treeId.toLowerCase()) {
      const candidate: ReviewedCommitCandidate = {
        branchRef: ref, preHead, commit: preHead, treeId: reviewed.treeId, diffHash: reviewed.diffHash, opId: metadata.opId,
      };
      await this.#verifyCandidate(info, candidate, reviewed);
      const finalRef = await this.readTaskBranchHead(info);
      if (finalRef.head.toLowerCase() !== preHead.toLowerCase()) throw new Error("Task branch changed while validating self-committed candidate");
      return candidate;
    }

    const message = `${metadata.message}\n\nZero-Operation-Id: ${metadata.opId}\n`;
    const { stdout } = await execFileAsync("git", [
      "-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync", "-c", "i18n.commitEncoding=UTF-8",
      "commit-tree", reviewed.treeId, "-p", preHead, "-m", message,
    ], {
      cwd: info.path,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Zero",
        GIT_AUTHOR_EMAIL: "zero@localhost",
        GIT_COMMITTER_NAME: "Zero",
        GIT_COMMITTER_EMAIL: "zero@localhost",
        GIT_AUTHOR_DATE: metadata.timestamp,
        GIT_COMMITTER_DATE: metadata.timestamp,
      },
    });
    const commit = stdout.trim();
    if (!/^[a-fA-F0-9]{40,64}$/.test(commit)) throw new Error("Git returned an invalid candidate commit id");
    const candidate: ReviewedCommitCandidate = {
      branchRef: ref, preHead, commit, treeId: reviewed.treeId, diffHash: reviewed.diffHash, opId: metadata.opId,
    };
    await this.#verifyCandidate(info, candidate, reviewed);
    const finalRef = await this.readTaskBranchHead(info);
    if (finalRef.head.toLowerCase() !== preHead.toLowerCase()) throw new Error("Task branch changed while creating commit candidate");
    return candidate;
  }

  /** Apply a prepared candidate with a compare-and-swap update of the task branch. */
  async applyReviewedCommitCandidate(
    info: WorktreeInfo,
    candidate: ReviewedCommitCandidate,
    reviewed: WorktreeReviewSnapshot,
  ): Promise<string> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    assertReviewSnapshot(reviewed);
    assertCandidate(candidate, info, reviewed);
    await this.#verifyCandidate(info, candidate, reviewed);
    const { ref, head } = await this.readTaskBranchHead(info);
    if (ref !== candidate.branchRef) throw new Error("Candidate targets an unexpected task branch ref");
    if (head.toLowerCase() === candidate.commit.toLowerCase()) {
      await this.#verifyAppliedCandidate(info, candidate, reviewed);
      return candidate.commit;
    }
    if (head.toLowerCase() !== candidate.preHead.toLowerCase()) throw new Error("Task branch moved before candidate apply");

    // Revalidate the approved live snapshot immediately before the only ref mutation.
    await this.#assertMatchesReview(info, reviewed, "before candidate apply");
    await this.#verifyCandidate(info, candidate, reviewed);
    await execFileAsync("git", [
      "-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync", "update-ref", candidate.branchRef, candidate.commit, candidate.preHead,
    ], {
      cwd: info.path, windowsHide: true,
    });
    await this.#verifyAppliedCandidate(info, candidate, reviewed);
    return candidate.commit;
  }

  /** Verify an already persisted candidate object before recovery claims work. */
  async verifyReviewedCommitCandidateObject(
    info: WorktreeInfo,
    candidate: ReviewedCommitCandidate,
    reviewed: WorktreeReviewSnapshot,
  ): Promise<void> {
    await this.#validateInfo(info);
    assertReviewSnapshot(reviewed);
    assertCandidate(candidate, info, reviewed);
    await this.#verifyCandidate(info, candidate, reviewed);
  }

  /**
   * Verify after a process restart that a previously persisted candidate was
   * already applied. This deliberately does not compare the pre-CAS snapshot:
   * after the ref moves, the candidate is the expected HEAD. It only inspects
   * the exact candidate object, target ref, HEAD, index, and clean worktree.
   */
  async verifyAppliedReviewedCommitCandidate(
    info: WorktreeInfo,
    candidate: ReviewedCommitCandidate,
    reviewed: WorktreeReviewSnapshot,
  ): Promise<void> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    assertReviewSnapshot(reviewed);
    assertCandidate(candidate, info, reviewed);
    await this.#verifyCandidate(info, candidate, reviewed);
    await this.#verifyAppliedCandidate(info, candidate, reviewed);
  }

  /** Final pre-DONE assertion that HEAD and the clean worktree still equal the reviewed commit. */
  async verifyReviewedCommit(info: WorktreeInfo, commit: string, reviewed: WorktreeReviewSnapshot): Promise<void> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: info.path, windowsHide: true });
    const head = stdout.trim();
    if (head !== commit || await this.#headTree(info) !== reviewed.treeId) {
      throw new Error("Task branch moved away from the reviewed commit");
    }
    const diff = await this.#diffCommit(info, commit);
    if (hash(diff) !== reviewed.diffHash || await this.status(info)) {
      throw new Error("Worktree no longer matches the reviewed commit");
    }
  }

  async #assertMatchesReview(info: WorktreeInfo, reviewed: WorktreeReviewSnapshot, phase: string): Promise<void> {
    const current = await this.captureReviewSnapshot(info);
    if (
      current.fingerprint !== reviewed.fingerprint ||
      current.treeId !== reviewed.treeId ||
      current.diffHash !== reviewed.diffHash
    ) {
      throw new Error(`Worktree no longer matches the reviewed snapshot ${phase}`);
    }
  }

  async #assertNoUnstagedChanges(info: WorktreeInfo): Promise<void> {
    const tracked = await execFileAsync("git", ["diff", "--quiet", "--"], { cwd: info.path, windowsHide: true })
      .catch(error => error as { code?: number });
    if ((tracked as { code?: number }).code === 1) throw new Error("Worktree has unstaged tracked changes");
    if ((tracked as { code?: number }).code !== undefined) throw new Error("Unable to inspect unstaged tracked changes");
    const { stdout: untracked } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: info.path,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (untracked) throw new Error("Worktree has unstaged untracked files");
  }

  async #writeTree(info: WorktreeInfo, env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync", "write-tree"], { cwd: info.path, windowsHide: true, env });
    const treeId = stdout.trim();
    if (!/^[a-fA-F0-9]{40,64}$/.test(treeId)) throw new Error("Git returned an invalid staged tree id");
    return treeId;
  }

  async #headTree(info: WorktreeInfo): Promise<string> {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: info.path, windowsHide: true });
    const treeId = stdout.trim();
    if (!/^[a-fA-F0-9]{40,64}$/.test(treeId)) throw new Error("Git returned an invalid HEAD tree id");
    return treeId;
  }

  async #head(info: WorktreeInfo): Promise<string> {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: info.path, windowsHide: true });
    const head = stdout.trim();
    if (!/^[a-fA-F0-9]{40,64}$/.test(head)) throw new Error("Git returned an invalid worktree HEAD");
    return head;
  }

  async #verifyCandidate(info: WorktreeInfo, candidate: ReviewedCommitCandidate, reviewed: WorktreeReviewSnapshot): Promise<void> {
    const { stdout: objectType } = await execFileAsync("git", ["cat-file", "-t", candidate.commit], { cwd: info.path, windowsHide: true });
    if (objectType.trim() !== "commit") throw new Error("Reviewed candidate object is missing or is not a commit");
    const { stdout: details } = await execFileAsync("git", ["show", "-s", "--format=%T%n%P%n%B", candidate.commit], { cwd: info.path, windowsHide: true });
    const [tree, parents, ...bodyLines] = details.replace(/\r/g, "").split("\n");
    const selfCommitted = candidate.commit.toLowerCase() === candidate.preHead.toLowerCase();
    if (tree?.toLowerCase() !== reviewed.treeId.toLowerCase()
      || (!selfCommitted && parents?.trim().toLowerCase() !== candidate.preHead.toLowerCase())) {
      throw new Error("Candidate commit does not have the reviewed tree and exact pre-HEAD parent");
    }
    const body = bodyLines.join("\n").trimEnd();
    if (!selfCommitted && !body.endsWith(`Zero-Operation-Id: ${candidate.opId}`)) throw new Error("Candidate commit operation id does not match");
    await execFileAsync("git", ["merge-base", "--is-ancestor", info.baseCommit, candidate.commit], { cwd: info.path, windowsHide: true });
    const diff = await this.#diffCommit(info, candidate.commit);
    if (hash(diff) !== reviewed.diffHash || candidate.diffHash !== reviewed.diffHash) {
      throw new Error("Candidate commit diff does not match the reviewed snapshot");
    }
  }

  async #verifyAppliedCandidate(info: WorktreeInfo, candidate: ReviewedCommitCandidate, reviewed: WorktreeReviewSnapshot): Promise<void> {
    const { ref, head } = await this.readTaskBranchHead(info);
    if (ref !== candidate.branchRef || head.toLowerCase() !== candidate.commit.toLowerCase()
      || (await this.#head(info)).toLowerCase() !== candidate.commit.toLowerCase()) {
      throw new Error("Task branch did not move to the reviewed candidate");
    }
    if ((await this.#headTree(info)).toLowerCase() !== reviewed.treeId.toLowerCase()
      || (await this.#writeTree(info)).toLowerCase() !== reviewed.treeId.toLowerCase()
      || hash(await this.#diffCommit(info, candidate.commit)) !== reviewed.diffHash
      || await this.status(info)) {
      throw new Error("Applied candidate does not leave a clean worktree matching the reviewed snapshot");
    }
  }

  async #diffTree(info: WorktreeInfo, treeId: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff", "--no-renames", "--binary", info.baseCommit, treeId, "--"], {
      cwd: info.path,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  async #diffCommit(info: WorktreeInfo, commit: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff", "--no-renames", "--binary", info.baseCommit, commit, "--"], {
      cwd: info.path,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  async remove(info: WorktreeInfo, options: { deleteBranch?: boolean } = {}): Promise<void> {
    await this.#validateInfo(info);
    await execFileAsync("git", ["worktree", "remove", "--force", info.path], { cwd: info.repoPath, windowsHide: true, maxBuffer: 1024 * 1024 });
    if (options.deleteBranch) await execFileAsync("git", ["branch", "-D", info.branch], { cwd: info.repoPath, windowsHide: true });
  }

  async #revalidateCreationPlan(plan: WorktreeCreationPlan): Promise<void> {
    this.#assertTaskId(plan.taskId);
    const [repo, root] = await Promise.all([realpath(plan.repoPath), realpath(this.#root)]);
    if (repo !== plan.repoPath) throw new Error("Repository path changed after worktree creation was planned");
    if (root !== plan.worktreeRoot) throw new Error("Worktree root changed after worktree creation was planned");
    const expectedPath = resolve(root, plan.taskId);
    this.#assertInside(root, plan.path);
    if (plan.path !== expectedPath) throw new Error("Worktree path does not match its planned task id");
    const { stdout: repoTop } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, windowsHide: true });
    if (await realpath(repoTop.trim()) !== plan.repoPath) throw new Error("Repository identity changed after worktree creation was planned");
    const { stdout: commonOutput } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, windowsHide: true });
    if (await realpath(commonOutput.trim()) !== plan.commonGitDir) throw new Error("Repository Git common directory changed after worktree creation was planned");
    if (plan.branch !== `zero/${plan.taskId}`) throw new Error("Worktree branch does not match its planned task id");
    if (!/^[a-fA-F0-9]{40,64}$/.test(plan.baseCommit)) throw new Error("Invalid planned base commit");
    const { stdout: baseOutput } = await execFileAsync("git", ["rev-parse", "--verify", `${plan.baseCommit}^{commit}`], { cwd: repo, windowsHide: true });
    if (baseOutput.trim().toLowerCase() !== plan.baseCommit.toLowerCase()) throw new Error("Planned base commit is no longer available");
    try {
      const stat = await lstat(plan.path);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink at task worktree path: ${plan.path}`);
      throw new Error(`Worktree path already exists: ${plan.path}`);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const branchRef = `refs/heads/${plan.branch}`;
    const existingBranch = await execFileAsync("git", ["show-ref", "--verify", "--quiet", branchRef], { cwd: repo, windowsHide: true })
      .then(() => true, error => (error as { code?: number }).code === 1 ? false : Promise.reject(error));
    if (existingBranch) throw new Error(`Worktree branch already exists: ${plan.branch}`);
  }

  async #validateInfo(info: WorktreeInfo): Promise<void> {
    this.#assertTaskId(info.taskId);
    const root = await realpath(this.#root);
    const path = await realpath(info.path);
    this.#assertInside(root, path);
    if (path !== resolve(root, info.taskId)) throw new Error("Worktree metadata path does not match task id");
    const repo = await realpath(info.repoPath);
    if (repo !== info.repoPath) throw new Error("Repository path changed since worktree creation");
  }

  async #safeWorktreePath(rootPath: string, gitPath: string): Promise<string> {
    const parts = gitPath.split(/[\\/]/);
    if (!parts.length || parts.some(part => !part || part === "." || part === "..")) {
      throw new Error(`Refusing unsafe Git path in worktree fingerprint: ${gitPath}`);
    }
    const root = await realpath(rootPath);
    const target = resolve(root, ...parts);
    this.#assertInside(root, target);
    let parent = root;
    for (const component of parts.slice(0, -1)) {
      parent = resolve(parent, component);
      this.#assertInside(root, parent);
      let parentStat;
      try { parentStat = await lstat(parent); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return target;
        throw error;
      }
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw new Error(`Refusing to traverse a non-directory or symlink in worktree path: ${gitPath}`);
      }
    }
    return target;
  }

  async #ensureTaskBranch(info: WorktreeInfo): Promise<void> {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: info.path, windowsHide: true });
    if (stdout.trim() !== info.branch) throw new Error(`Refusing to inspect or commit a worktree checked out on unexpected branch ${stdout.trim()}`);
  }

  #assertTaskId(id: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error("Task id contains unsafe path characters");
  }

  #assertInside(root: string, target: string): void {
    const rel = relative(root, target);
    if (!rel || rel === ".") return;
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path escapes configured directory: ${target}`);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseWorktreePorcelain(value: string): Array<{
  worktree?: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
}> {
  const entries: Array<{ worktree?: string; head?: string; branch?: string; detached: boolean; bare: boolean; prunable: boolean }> = [];
  let current: { worktree?: string; head?: string; branch?: string; detached: boolean; bare: boolean; prunable: boolean } | undefined;
  for (const field of value.split("\0")) {
    if (!field) {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    current ??= { detached: false, bare: false, prunable: false };
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const content = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") current.worktree = content;
    else if (key === "HEAD") current.head = content;
    else if (key === "branch") current.branch = content;
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "prunable") current.prunable = true;
  }
  if (current) entries.push(current);
  if (!entries.length || entries.some(entry => !entry.worktree || !entry.head)) {
    throw new Error("Git returned an incomplete worktree registration list");
  }
  return entries;
}

function readNameStatusPaths(value: string): string[] {
  const chunks = value.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < chunks.length;) {
    const status = chunks[index++]!;
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let part = 0; part < count && index < chunks.length; part++) {
      paths.push(chunks[index++]!.replaceAll("\\", "/"));
    }
  }
  return paths;
}

function assertReviewSnapshot(value: WorktreeReviewSnapshot): void {
  if (!value || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !/^[a-f0-9]{64}$/.test(value.diffHash)
    || !/^[a-fA-F0-9]{40,64}$/.test(value.treeId) || typeof value.diff !== "string"
    || hash(value.diff) !== value.diffHash) {
    throw new Error("Invalid reviewed worktree snapshot");
  }
}

function assertCommitMetadata(value: ReviewedCommitMetadata): void {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.opId)
    || typeof value.message !== "string" || !value.message.trim() || value.message.includes("\0")
    || typeof value.timestamp !== "string" || !value.timestamp.trim() || value.timestamp.includes("\0")) {
    throw new Error("Invalid reviewed commit metadata");
  }
}

function assertCandidate(value: ReviewedCommitCandidate, info: WorktreeInfo, reviewed: WorktreeReviewSnapshot): void {
  if (!value || value.branchRef !== `refs/heads/${info.branch}`
    || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value.branchRef)
    || !/^[a-fA-F0-9]{40,64}$/.test(value.preHead) || !/^[a-fA-F0-9]{40,64}$/.test(value.commit)
    || value.treeId?.toLowerCase() !== reviewed.treeId.toLowerCase() || value.diffHash !== reviewed.diffHash
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.opId)) {
    throw new Error("Invalid reviewed commit candidate");
  }
}
