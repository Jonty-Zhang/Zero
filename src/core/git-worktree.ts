import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  taskId: string;
  repoPath: string;
  path: string;
  branch: string;
  baseCommit: string;
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

  async create(taskId: string, repoPath: string, baseRef: string): Promise<WorktreeInfo> {
    this.#assertTaskId(taskId);
    if (!baseRef || baseRef.startsWith("-")) throw new Error("Invalid baseRef");
    const repo = await realpath(repoPath);
    const { stdout: repoTop } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, windowsHide: true });
    const canonicalRepo = await realpath(repoTop.trim());
    const { stdout: baseOutput } = await execFileAsync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: canonicalRepo, windowsHide: true });
    const baseCommit = baseOutput.trim();
    await mkdir(this.#root, { recursive: true });
    const safeRoot = await realpath(this.#root);
    const path = resolve(safeRoot, taskId);
    this.#assertInside(safeRoot, path);
    try { await lstat(path); throw new Error(`Worktree path already exists: ${path}`); } catch (e) {
      if (!(e instanceof Error) || !("code" in e) || e.code !== "ENOENT") throw e;
    }
    const branch = `zero/${taskId}`;
    await execFileAsync("git", ["worktree", "add", "-b", branch, path, baseCommit], { cwd: canonicalRepo, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { taskId, repoPath: canonicalRepo, path, branch, baseCommit };
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

  async changedPaths(info: WorktreeInfo): Promise<string[]> {
    await this.#ensureTaskBranch(info);
    const { stdout: committed } = await execFileAsync("git", ["diff", "--name-status", "-z", info.baseCommit, "HEAD", "--"], { cwd: info.path, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const committedParts = committed.split("\0").filter(Boolean);
    const committedPaths: string[] = [];
    for (let i = 0; i < committedParts.length;) {
      const status = committedParts[i++]!;
      const count = /^[RC]/.test(status) ? 2 : 1;
      for (let j = 0; j < count && i < committedParts.length; j++) committedPaths.push(committedParts[i++]!.replaceAll("\\", "/"));
    }
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

  async commit(info: WorktreeInfo, message = "Zero task result"): Promise<string | undefined> {
    await this.#validateInfo(info);
    await this.#ensureTaskBranch(info);
    const before = await this.diff(info);
    if (!before.trim()) return undefined;
    await execFileAsync("git", ["add", "-A"], { cwd: info.path, windowsHide: true });
    const status = await execFileAsync("git", ["diff", "--cached", "--quiet"], { cwd: info.path, windowsHide: true }).catch(e => e as { code?: number });
    if ((status as { code?: number }).code === 1) {
      await execFileAsync("git", ["-c", "user.name=Zero", "-c", "user.email=zero@localhost", "commit", "-m", message], { cwd: info.path, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    } else if ((status as { code?: number }).code !== undefined) {
      throw new Error("Unable to inspect staged changes before task commit");
    }
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: info.path, windowsHide: true });
    const head = stdout.trim();
    if (head === info.baseCommit) return undefined;
    const { stdout: committedDiff } = await execFileAsync("git", ["diff", "--no-ext-diff", "--no-renames", "--binary", `${info.baseCommit}..${head}`, "--"], { cwd: info.path, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return committedDiff.trim() ? head : undefined;
  }

  async remove(info: WorktreeInfo, options: { deleteBranch?: boolean } = {}): Promise<void> {
    await this.#validateInfo(info);
    await execFileAsync("git", ["worktree", "remove", "--force", info.path], { cwd: info.repoPath, windowsHide: true, maxBuffer: 1024 * 1024 });
    if (options.deleteBranch) await execFileAsync("git", ["branch", "-D", info.branch], { cwd: info.repoPath, windowsHide: true });
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
