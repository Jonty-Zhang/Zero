import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TrustedCodexCwdOptions {
  artifactRoot: string;
  purpose: 'route' | 'review';
  /** The repository or worktree whose AGENTS.md and content must not be loaded. */
  taskWorkspace: string;
  /** Include a bounded, data-only copy of the task worktree for an independent code review. */
  includeProjectSnapshot?: boolean;
}

export interface ProjectSnapshotEntry {
  sourcePath: string;
  snapshotPath: string;
  mode: '100644' | '100755';
  bytes: number;
  indexBlob: string;
  sha256: string;
}

export interface ProjectSnapshotManifest {
  version: 1;
  source: 'git-index-blobs';
  headCommit: string;
  /** Tree recorded by the source repository index. */
  indexTree: string;
  fileHashBasis: 'staged-index-blob-bytes';
  fileCount: number;
  totalBytes: number;
  contentSha256: string;
  files: ProjectSnapshotEntry[];
  excluded: Array<{ path: string; reason: string }>;
  transformed: Array<{ sourcePath: string; snapshotPath: string; reason: string }>;
  ignoredFiles: 'ignored files are not enumerated by git ls-files --exclude-standard';
}

export interface ProjectSnapshot {
  root: string;
  manifestPath: string;
  summary: string;
  manifest: ProjectSnapshotManifest;
}

export interface TrustedCodexCwd {
  cwd: string;
  projectSnapshot?: ProjectSnapshot;
  dispose(): Promise<void>;
}

export interface GoalProjectSource {
  repositoryId: string;
  targetTaskId: string;
  taskWorkspace: string;
}

export interface GoalProjectSnapshot {
  source: GoalProjectSource;
  snapshot: ProjectSnapshot;
}

const MAX_SNAPSHOT_FILES = 10_000;
const MAX_SNAPSHOT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 64 * 1024 * 1024;

/** Build one bounded review bundle; repository IDs, never source paths, name its namespaces. */
export async function createTrustedGoalCwd(options: { artifactRoot: string; repositories: GoalProjectSource[] }): Promise<{
  cwd: string;
  projectSnapshots: GoalProjectSnapshot[];
  manifestPath: string;
  contentSha256: string;
  dispose(): Promise<void>;
}> {
  if (!Array.isArray(options.repositories) || options.repositories.length < 1 || options.repositories.length > 20) {
    throw new Error('Goal review snapshot requires between 1 and 20 repositories');
  }
  const repositoryIds = new Set<string>();
  const targetTaskIds = new Set<string>();
  // Capture caller-owned mappings before the first asynchronous operation.
  const sources = options.repositories.map((source) => {
    if (typeof source.repositoryId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(source.repositoryId)) throw new Error('Goal review snapshot has an invalid repository ID');
    if (typeof source.targetTaskId !== 'string' || !source.targetTaskId.trim() || source.targetTaskId.length > 256 || /[\x00-\x1f\x7f]/.test(source.targetTaskId)) throw new Error('Goal review snapshot has an invalid target task ID');
    const namespace = process.platform === 'win32' ? source.repositoryId.toLowerCase() : source.repositoryId;
    if (repositoryIds.has(namespace) || targetTaskIds.has(source.targetTaskId)) throw new Error('Goal review snapshot has duplicate repository or target task IDs');
    repositoryIds.add(namespace);
    targetTaskIds.add(source.targetTaskId);
    if (!isAbsolute(source.taskWorkspace)) throw new Error('Trusted Codex cwd paths must be absolute');
    return { ...source };
  });
  if (!isAbsolute(options.artifactRoot)) throw new Error('Trusted Codex cwd paths must be absolute');
  const sourceRoots = await Promise.all(sources.map(source => realpath(source.taskWorkspace)));
  const plannedArtifactRoot = await resolveUncreatedPath(options.artifactRoot);
  if (sourceRoots.some(root => isWithin(root, plannedArtifactRoot))) throw new Error('Trusted Codex cwd would overlap a task workspace');
  await mkdir(options.artifactRoot, { recursive: true });
  const artifactRoot = await realpath(options.artifactRoot);
  const setupId = randomUUID();
  const sandboxPath = join(artifactRoot, `.zero-codex-review-${setupId}`);
  const gitConfigPath = join(artifactRoot, `.zero-codex-git-config-${setupId}`);
  if (!isWithin(artifactRoot, sandboxPath) || sourceRoots.some(root => isWithin(root, sandboxPath) || isWithin(sandboxPath, root))) {
    throw new Error('Trusted Codex cwd would overlap a task workspace or escape artifactRoot');
  }
  for (const sourceRoot of sourceRoots) await assertNoAgentInstructions(sandboxPath, sourceRoot);
  let created = false;
  let identity: Awaited<ReturnType<typeof lstat>> | undefined;
  const dispose = async (): Promise<void> => {
    const info = await lstat(sandboxPath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) return;
    const current = await realpath(sandboxPath);
    if (!identity || info.isSymbolicLink() || !info.isDirectory() || info.dev !== identity.dev || info.ino !== identity.ino || current !== sandboxPath || !isWithin(artifactRoot, current) || sourceRoots.some(root => isWithin(root, current) || isWithin(current, root))) {
      throw new Error('Refusing to remove a Trusted Codex cwd whose resolved path or identity changed');
    }
    await rm(current, { recursive: true, force: false });
  };
  try {
    await writeFile(gitConfigPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await mkdir(sandboxPath, { recursive: false, mode: 0o700 });
    created = true;
    identity = await lstat(sandboxPath);
    if (await realpath(sandboxPath) !== sandboxPath) throw new Error('Trusted Codex cwd resolved outside artifactRoot');
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', '--template='], {
      cwd: sandboxPath, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, env: safeGitEnvironment(gitConfigPath),
    });
    const prepared: PreparedProjectSnapshot[] = [];
    const budget = { files: 0, bytes: 0 };
    // All repositories must pass metadata and size preflight before any blob is read.
    for (const sourceRoot of sourceRoots) prepared.push(await prepareProjectSnapshot(sourceRoot, gitConfigPath, budget));
    const projectSnapshots: GoalProjectSnapshot[] = [];
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!;
      const snapshot = await createProjectSnapshot(sourceRoots[index]!, sandboxPath, prepared[index]!, `review-context/projects/${source.repositoryId}`);
      projectSnapshots.push({ source, snapshot });
    }
    // Recheck every source after the entire bundle is written, including earlier sources.
    for (const project of prepared) await assertProjectSnapshotUnchanged(project);
    for (const sourceRoot of sourceRoots) await assertNoAgentInstructions(sandboxPath, sourceRoot);
    const repositories = projectSnapshots.map(({ source, snapshot }) => ({
      repositoryId: source.repositoryId,
      targetTaskId: source.targetTaskId,
      projectRoot: `review-context/projects/${source.repositoryId}/project`,
      manifestPath: `review-context/projects/${source.repositoryId}/manifest.json`,
      headCommit: snapshot.manifest.headCommit,
      indexTree: snapshot.manifest.indexTree,
      contentSha256: snapshot.manifest.contentSha256,
      fileCount: snapshot.manifest.fileCount,
      totalBytes: snapshot.manifest.totalBytes,
    }));
    const contentSha256 = createHash('sha256').update(JSON.stringify(repositories)).digest('hex');
    const manifestPath = join(sandboxPath, 'review-context', 'repositories.json');
    await writeFile(manifestPath, `${JSON.stringify({ version: 1, repositories, contentSha256 }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { cwd: sandboxPath, projectSnapshots, manifestPath, contentSha256, dispose };
  } catch (error) {
    if (created) await dispose().catch(() => undefined);
    throw error;
  } finally {
    await rm(gitConfigPath, { force: true }).catch(() => undefined);
  }
}

/** Resolve existing ancestors without creating an artifact directory inside a source. */
async function resolveUncreatedPath(path: string): Promise<string> {
  let existing = resolve(path);
  for (;;) {
    try { return resolve(await realpath(existing), relative(existing, path)); }
    catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

/**
 * Creates a fresh Git repository below artifactRoot for a coordinator/reviewer Codex
 * session. Review calls can include a bounded, data-only project source snapshot.
 * It refuses paths overlapping the task workspace and any AGENTS.md in the cwd
 * ancestor chain. Review snapshots also refuse a project .codex config that would be
 * inherited by the Codex cwd, then remove only the generated directory on dispose.
 */
export async function createTrustedCodexCwd(options: TrustedCodexCwdOptions): Promise<TrustedCodexCwd> {
  if (!isAbsolute(options.artifactRoot) || !isAbsolute(options.taskWorkspace)) throw new Error('Trusted Codex cwd paths must be absolute');
  await mkdir(options.artifactRoot, { recursive: true });
  const artifactRoot = await realpath(options.artifactRoot);
  const taskWorkspace = await realpath(options.taskWorkspace);
  const setupId = randomUUID();
  const sandboxPath = join(artifactRoot, `.zero-codex-${options.purpose}-${setupId}`);
  const templatePath = join(artifactRoot, `.zero-codex-template-${setupId}`);
  const globalConfigPath = join(artifactRoot, `.zero-codex-git-config-${setupId}`);
  if (!isWithin(artifactRoot, sandboxPath) || isWithin(taskWorkspace, sandboxPath) || isWithin(sandboxPath, taskWorkspace)) {
    throw new Error('Trusted Codex cwd would overlap the task workspace or escape artifactRoot');
  }
    await assertNoAgentInstructions(sandboxPath, options.includeProjectSnapshot ? taskWorkspace : undefined);
  let createdPath: string | undefined;
  try {
    await mkdir(templatePath, { recursive: false, mode: 0o700 });
    await writeFile(globalConfigPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await mkdir(sandboxPath, { recursive: false, mode: 0o700 });
    createdPath = await realpath(sandboxPath);
    if (createdPath !== sandboxPath || !isWithin(artifactRoot, createdPath)) throw new Error('Trusted Codex cwd resolved outside artifactRoot');
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', `--template=${templatePath}`], {
      cwd: createdPath,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: safeGitEnvironment(globalConfigPath),
    });
    await rm(templatePath, { recursive: true, force: false });
    await rm(globalConfigPath, { force: false });
    const projectSnapshot = options.includeProjectSnapshot
      ? await createProjectSnapshot(taskWorkspace, createdPath)
      : undefined;
    await assertNoAgentInstructions(createdPath, options.includeProjectSnapshot ? taskWorkspace : undefined);
    return {
      cwd: createdPath,
      ...(projectSnapshot ? { projectSnapshot } : {}),
      dispose: async () => {
        const current = await realpath(createdPath!).catch(() => undefined);
        if (!current) return;
        if (current !== createdPath || !isWithin(artifactRoot, current) || isWithin(taskWorkspace, current) || isWithin(current, taskWorkspace)) {
          throw new Error('Refusing to remove a Trusted Codex cwd whose resolved path changed');
        }
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing to remove a non-directory Trusted Codex cwd');
        await rm(current, { recursive: true, force: false });
      },
    };
  } catch (error) {
    if (isWithin(artifactRoot, sandboxPath)) await rm(sandboxPath, { recursive: true, force: true }).catch(() => undefined);
    if (createdPath && createdPath !== sandboxPath && isWithin(artifactRoot, createdPath)) {
      await rm(createdPath, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(templatePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(globalConfigPath, { force: true }).catch(() => undefined);
  }
}

interface PreparedProjectSnapshot {
  taskWorkspace: string;
  gitConfigPath: string;
  headCommit: string;
  indexTree: string;
  stagedListing: Buffer;
  untrackedListing: Buffer;
  sourceEntries: GitIndexEntry[];
  excluded: ProjectSnapshotManifest['excluded'];
}

function snapshotGitOptions(taskWorkspace: string, gitConfigPath: string) {
  return {
    cwd: taskWorkspace, windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    encoding: 'buffer', env: safeGitEnvironment(gitConfigPath),
  } as const;
}

/** A failed command must not leave sibling Git processes holding source paths open. */
async function settleGitCommands<T extends readonly unknown[]>(commands: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(commands);
  return results.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  }) as unknown as T;
}

async function prepareProjectSnapshot(taskWorkspace: string, gitConfigPath: string, budget: { files: number; bytes: number }): Promise<PreparedProjectSnapshot> {
  const gitOptions = snapshotGitOptions(taskWorkspace, gitConfigPath);
  const [head, index, stagedListing, untrackedListing] = await settleGitCommands([
    execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], gitOptions),
    execFileAsync('git', ['write-tree'], gitOptions),
    execFileAsync('git', ['ls-files', '--stage', '-z'], gitOptions),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], gitOptions),
  ]);
  const headCommit = head.stdout.toString('utf8').trim();
  const indexTree = index.stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/i.test(headCommit) || !/^[0-9a-f]{40,64}$/i.test(indexTree)) {
    throw new Error('Project review snapshot could not verify the worktree HEAD and index tree');
  }
  const indexEntries = parseStageListing(stagedListing.stdout);
  const untrackedPaths = decodeGitListing(untrackedListing.stdout).split('\0').filter(Boolean);
  if (untrackedPaths.length) throw new Error('Project review snapshot found non-ignored files outside the Git index; stage them before review');
  const excluded: ProjectSnapshotManifest['excluded'] = [];
  const sourceEntries = indexEntries.filter((entry) => {
    const parts = validateGitPath(entry.path);
    if (!parts.some((part) => part.toLowerCase() === '.git')) return true;
    excluded.push({ path: entry.path, reason: 'Git metadata is excluded from the review snapshot' });
    return false;
  });
  budget.files += sourceEntries.length;
  if (budget.files > MAX_SNAPSHOT_FILES) {
    throw new Error(`Project review snapshot exceeds the ${MAX_SNAPSHOT_FILES} file limit`);
  }
  for (const entry of sourceEntries) {
    validateGitPath(entry.path);
    if (entry.stage !== 0) throw new Error(`Project review snapshot found an unresolved Git index entry: ${entry.path}`);
    if (entry.mode === '120000') throw new Error(`Project review snapshot refuses symbolic links: ${entry.path}`);
    if (entry.mode === '160000') throw new Error(`Project review snapshot refuses Git submodules: ${entry.path}`);
    if (entry.mode !== '100644' && entry.mode !== '100755') throw new Error(`Project review snapshot found an unsupported Git file mode: ${entry.path}`);
  }
  for (const size of await readIndexBlobSizes(taskWorkspace, sourceEntries, gitConfigPath)) {
    budget.bytes += size;
    if (budget.bytes > MAX_SNAPSHOT_TOTAL_BYTES) throw new Error(`Project review snapshot exceeds the ${MAX_SNAPSHOT_TOTAL_BYTES} byte total limit`);
  }
  return { taskWorkspace, gitConfigPath, headCommit, indexTree, stagedListing: stagedListing.stdout, untrackedListing: untrackedListing.stdout, sourceEntries, excluded };
}

async function createProjectSnapshot(taskWorkspace: string, sandbox: string, prepared?: PreparedProjectSnapshot, namespace = 'review-context'): Promise<ProjectSnapshot> {
  const project = prepared ?? await prepareProjectSnapshot(taskWorkspace, join(sandbox, '.snapshot-git-config'), { files: 0, bytes: 0 });
  const { gitConfigPath, headCommit, indexTree, sourceEntries, excluded } = project;
  const blobContents = await readIndexBlobs(taskWorkspace, sourceEntries, gitConfigPath);

  const root = join(sandbox, namespace, 'project');
  const manifestPath = join(sandbox, namespace, 'manifest.json');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  if (!isWithin(sandbox, realRoot)) throw new Error('Project review snapshot directory escaped the trusted Codex cwd');

  const files: ProjectSnapshotEntry[] = [];
  const transformed: ProjectSnapshotManifest['transformed'] = [];
  let totalBytes = 0;
  for (let entryIndex = 0; entryIndex < sourceEntries.length; entryIndex++) {
    const entry = sourceEntries[entryIndex]!;
    const sourcePath = entry.path;
    const parts = validateGitPath(sourcePath);
    if (files.length >= MAX_SNAPSHOT_FILES) throw new Error(`Project review snapshot exceeds the ${MAX_SNAPSHOT_FILES} file limit`);
    const bytes = blobContents[entryIndex]!;
    if (bytes.length > MAX_SNAPSHOT_FILE_BYTES) throw new Error(`Project review snapshot file exceeds the ${MAX_SNAPSHOT_FILE_BYTES} byte limit: ${sourcePath}`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) throw new Error(`Project review snapshot exceeds the ${MAX_SNAPSHOT_TOTAL_BYTES} byte total limit`);

    const mappedParts = mapDataOnlyPath(parts, sourcePath, transformed);
    const target = join(root, ...mappedParts);
    if (!isWithin(root, target)) throw new Error(`Project review snapshot target escaped its root: ${sourcePath}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    const targetRealPath = await realpath(target);
    if (!isWithin(realRoot, targetRealPath)) throw new Error(`Project review snapshot target escaped its root: ${sourcePath}`);
    files.push({
      sourcePath,
      snapshotPath: relative(root, target).split(sep).join('/'),
      mode: entry.mode as ProjectSnapshotEntry['mode'],
      bytes: bytes.length,
      indexBlob: entry.oid,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }

  await assertProjectSnapshotUnchanged(project);

  const contentHash = createHash('sha256');
  for (const file of files) contentHash.update(`${file.sourcePath}\0${file.indexBlob}\0${file.bytes}\0${file.sha256}\n`);
  const manifest: ProjectSnapshotManifest = {
    version: 1,
    source: 'git-index-blobs',
    headCommit,
    indexTree,
    fileHashBasis: 'staged-index-blob-bytes',
    fileCount: files.length,
    totalBytes,
    contentSha256: contentHash.digest('hex'),
    files,
    excluded,
    transformed,
    ignoredFiles: 'ignored files are not enumerated by git ls-files --exclude-standard',
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const summary = [
    `Snapshot: ${namespace}/project (manifest: ${namespace}/manifest.json)`,
    `Source state: HEAD ${headCommit}; index tree ${indexTree}.`,
    `Coverage: ${files.length} staged Git index blobs; ${totalBytes} bytes; SHA-256 ${manifest.contentSha256}.`,
    `Excluded: ${excluded.length} Git metadata path(s); non-ignored files outside the index cause a blocked review.`,
    `Transformed data paths: ${transformed.length} (AGENTS.md and .codex names are renamed to prevent automatic instruction/config loading).`,
    'The manifest lists every copied path, hash, exclusion, and transformed name. If required context is missing, return blocked.',
  ].join('\n');
  return { root, manifestPath, summary, manifest };
}

async function assertProjectSnapshotUnchanged(project: PreparedProjectSnapshot): Promise<void> {
  const gitOptions = snapshotGitOptions(project.taskWorkspace, project.gitConfigPath);
  const [headAfter, indexAfter, stagedListingAfter, untrackedAfter] = await settleGitCommands([
    execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], gitOptions),
    execFileAsync('git', ['write-tree'], gitOptions),
    execFileAsync('git', ['ls-files', '--stage', '-z'], gitOptions),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], gitOptions),
  ]);
  if (headAfter.stdout.toString('utf8').trim() !== project.headCommit || indexAfter.stdout.toString('utf8').trim() !== project.indexTree || !stagedListingAfter.stdout.equals(project.stagedListing) || !untrackedAfter.stdout.equals(project.untrackedListing)) {
    throw new Error('Project Git HEAD or index changed while the review snapshot was being created');
  }
}

function validateGitPath(sourcePath: string): string[] {
  if (!sourcePath || sourcePath.includes('\0') || isAbsolute(sourcePath) || win32.isAbsolute(sourcePath)) {
    throw new Error('Project review snapshot contains an invalid Git path');
  }
  const parts = sourcePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':') || part.includes('\\'))) {
    throw new Error('Project review snapshot contains an invalid Git path');
  }
  return parts;
}

interface GitIndexEntry { mode: string; oid: string; stage: number; path: string }

function parseStageListing(value: Buffer): GitIndexEntry[] {
  const decoded = decodeGitListing(value);
  const entries: GitIndexEntry[] = [];
  for (const record of decoded.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error('Project review snapshot received an invalid Git index listing');
    const [mode, oid, stageText] = record.slice(0, separator).split(' ');
    const path = record.slice(separator + 1);
    const stage = Number(stageText);
    if (!mode || !oid || !/^[0-9a-f]{40,64}$/i.test(oid) || !Number.isInteger(stage) || stage < 0 || stage > 3 || !path) {
      throw new Error('Project review snapshot received an invalid Git index entry');
    }
    entries.push({ mode, oid, stage, path });
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.stage - right.stage);
  return entries;
}

function decodeGitListing(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new Error('Project review snapshot Git paths are not valid UTF-8');
  }
}

async function readIndexBlobs(taskWorkspace: string, entries: GitIndexEntry[], gitConfigPath: string): Promise<Buffer[]> {
  if (!entries.length) return [];
  return parseBatchBlobs(await runGitBatch(taskWorkspace, entries, gitConfigPath, false), entries);
}

async function readIndexBlobSizes(taskWorkspace: string, entries: GitIndexEntry[], gitConfigPath: string): Promise<number[]> {
  if (!entries.length) return [];
  const output = await runGitBatch(taskWorkspace, entries, gitConfigPath, true);
  const records = output.toString('ascii').split('\n');
  if (records.pop() !== '' || records.length !== entries.length) throw new Error('Project review snapshot received an invalid Git blob size listing');
  return records.map((record, index) => {
    const [oid, type, sizeText] = record.split(' ');
    const size = Number(sizeText);
    if (oid !== entries[index]!.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('Project review snapshot received an unexpected Git blob size response');
    if (size > MAX_SNAPSHOT_FILE_BYTES) throw new Error(`Project review snapshot file exceeds the ${MAX_SNAPSHOT_FILE_BYTES} byte limit: ${entries[index]!.path}`);
    return size;
  });
}

async function runGitBatch(taskWorkspace: string, entries: GitIndexEntry[], gitConfigPath: string, sizesOnly: boolean): Promise<Buffer> {
  const maxOutputBytes = (sizesOnly ? 0 : MAX_SNAPSHOT_TOTAL_BYTES) + entries.length * 128 + 1024;
  const env = safeGitEnvironment(gitConfigPath);
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return await new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['cat-file', sizesOnly ? '--batch-check' : '--batch'], {
      cwd: taskWorkspace,
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.kill();
      rejectPromise(error);
    };
    timeout = setTimeout(() => fail(new Error('Project review snapshot Git blob read timed out')), 30_000);
    child.on('error', (error) => fail(new Error(`Project review snapshot could not read Git index blobs: ${error.message}`)));
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        fail(new Error('Project review snapshot Git blob output exceeded its size limit'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        rejectPromise(new Error('Project review snapshot could not read Git index blobs'));
        return;
      }
      resolvePromise(Buffer.concat(chunks, outputBytes));
    });
    child.stdin.on('error', (error) => fail(new Error(`Project review snapshot could not request Git index blobs: ${error.message}`)));
    child.stdin.end(`${entries.map((entry) => entry.oid).join('\n')}\n`);
  });
}

function parseBatchBlobs(output: Buffer, entries: GitIndexEntry[]): Buffer[] {
  const blobs: Buffer[] = [];
  let offset = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error('Project review snapshot received a truncated Git blob header');
    const [oid, type, sizeText] = output.toString('ascii', offset, headerEnd).split(' ');
    const size = Number(sizeText);
    if (oid !== entry.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('Project review snapshot received an unexpected Git blob response');
    }
    if (size > MAX_SNAPSHOT_FILE_BYTES) throw new Error(`Project review snapshot file exceeds the ${MAX_SNAPSHOT_FILE_BYTES} byte limit: ${entry.path}`);
    totalBytes += size;
    if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) throw new Error(`Project review snapshot exceeds the ${MAX_SNAPSHOT_TOTAL_BYTES} byte total limit`);
    offset = headerEnd + 1;
    const contentEnd = offset + size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) throw new Error('Project review snapshot received a truncated Git blob');
    blobs.push(Buffer.from(output.subarray(offset, contentEnd)));
    offset = contentEnd + 1;
  }
  if (offset !== output.length) throw new Error('Project review snapshot received extra Git blob data');
  return blobs;
}

function mapDataOnlyPath(parts: string[], sourcePath: string, transformed: ProjectSnapshotManifest['transformed']): string[] {
  let changed = false;
  const mapped = parts.map((part) => {
    if (part.toLowerCase() === '.codex') {
      changed = true;
      return `${part}.review-data`;
    }
    if (part.toLowerCase() === 'agents.md') {
      changed = true;
      return `${part}.review-data`;
    }
    return part;
  });
  if (changed) transformed.push({
    sourcePath,
    snapshotPath: mapped.join('/'),
    reason: 'Renamed as data to prevent automatic Codex instruction/config discovery',
  });
  return mapped;
}

export function isWithin(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function assertNoAgentInstructions(cwd: string, projectWorkspace?: string): Promise<void> {
  let current = cwd;
  for (;;) {
    const agentFile = join(current, 'AGENTS.md');
    try {
      await lstat(agentFile);
      throw new Error(`Trusted Codex cwd has an AGENTS.md in its ancestor chain: ${agentFile}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Trusted Codex cwd has an AGENTS.md')) throw error;
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (projectWorkspace) {
    const [topLevel, commonDirectory] = await settleGitCommands([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: projectWorkspace,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: safeGitEnvironment(join(cwd, '.snapshot-git-config')),
      }),
      execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: projectWorkspace,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: safeGitEnvironment(join(cwd, '.snapshot-git-config')),
      }),
    ]);
    const projectRoot = await findProjectRepositoryRoot(topLevel.stdout.trim(), commonDirectory.stdout.trim());
    if (isWithin(projectRoot, cwd)) {
      let current = cwd;
      for (;;) {
        try {
          await lstat(join(current, '.codex'));
          throw new Error('Trusted Codex cwd has a project .codex configuration directory in its ancestor chain');
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Trusted Codex cwd has a project .codex')) throw error;
          if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
        }
        if (current === projectRoot) break;
        const parent = dirname(current);
        if (!isWithin(projectRoot, parent)) throw new Error('Trusted Codex cwd escaped the task repository while checking project configuration');
        current = parent;
      }
    }
  }
}

async function findProjectRepositoryRoot(topLevelPath: string, commonDirectoryPath: string): Promise<string> {
  const topLevel = await realpath(topLevelPath);
  let current = await realpath(commonDirectoryPath);
  for (;;) {
    if (basename(current).toLowerCase() === '.git') return dirname(current);
    const parent = dirname(current);
    if (parent === current) return topLevel;
    current = parent;
  }
}

export interface WorktreeTextNormalization {
  autocrlf: 'true' | 'false' | 'input';
  eol: 'native' | 'lf' | 'crlf';
}

/** Preserve only safe text-conversion scalars when inspecting a writer's worktree. */
export async function worktreeGitEnvironment(globalConfigPath: string, taskWorkspace: string): Promise<{
  env: NodeJS.ProcessEnv; textNormalization: WorktreeTextNormalization;
}> {
  const queryEnv: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  // Pure config reads retain the writer's effective system/global settings, but
  // neither repository redirects nor the legacy config-only override may retarget them.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG']) delete queryEnv[key];
  const read = async (key: string, boolean: boolean, fallback: string): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', ['config', '--null', ...(boolean ? ['--type=bool-or-str'] : []), '--get', key],
        { cwd: taskWorkspace, env: queryEnv, windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
      if (!stdout.endsWith('\0')) throw new Error('Invalid source Git text configuration');
      return stdout.slice(0, -1).toLowerCase();
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return fallback;
      throw new Error('Source Git text configuration could not be read safely');
    }
  };
  const [autocrlf, eol] = await settleGitCommands([
    read('core.autocrlf', true, 'false'), read('core.eol', false, 'native'),
  ]);
  if (!['true', 'false', 'input'].includes(autocrlf) || !['native', 'lf', 'crlf'].includes(eol)) {
    throw new Error('Source Git text configuration is unsupported');
  }
  const env = safeGitEnvironment(globalConfigPath);
  env.GIT_CONFIG_COUNT = '5';
  env.GIT_CONFIG_KEY_3 = 'core.autocrlf'; env.GIT_CONFIG_VALUE_3 = autocrlf;
  env.GIT_CONFIG_KEY_4 = 'core.eol'; env.GIT_CONFIG_VALUE_4 = eol;
  return { env, textNormalization: { autocrlf: autocrlf as WorktreeTextNormalization['autocrlf'], eol: eol as WorktreeTextNormalization['eol'] } };
}

export function safeGitEnvironment(globalConfigPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.untrackedCache',
    GIT_CONFIG_VALUE_1: 'false',
    // Scoped to these owned Git subprocesses; never changes user/system config.
    GIT_CONFIG_KEY_2: 'core.longpaths',
    GIT_CONFIG_VALUE_2: 'true',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
