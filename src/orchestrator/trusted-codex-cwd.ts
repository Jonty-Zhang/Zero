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

const MAX_SNAPSHOT_FILES = 10_000;
const MAX_SNAPSHOT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 64 * 1024 * 1024;

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
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main'], {
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

async function createProjectSnapshot(taskWorkspace: string, sandbox: string): Promise<ProjectSnapshot> {
  const gitConfigPath = join(sandbox, '.snapshot-git-config');
  const gitOptions = {
    cwd: taskWorkspace,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'buffer',
    env: safeGitEnvironment(gitConfigPath),
  } as const;
  const [head, index, stagedListing, untrackedListing] = await Promise.all([
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
  if (sourceEntries.length > MAX_SNAPSHOT_FILES) {
    throw new Error(`Project review snapshot exceeds the ${MAX_SNAPSHOT_FILES} file limit`);
  }
  for (const entry of sourceEntries) {
    validateGitPath(entry.path);
    if (entry.stage !== 0) throw new Error(`Project review snapshot found an unresolved Git index entry: ${entry.path}`);
    if (entry.mode === '120000') throw new Error(`Project review snapshot refuses symbolic links: ${entry.path}`);
    if (entry.mode === '160000') throw new Error(`Project review snapshot refuses Git submodules: ${entry.path}`);
    if (entry.mode !== '100644' && entry.mode !== '100755') throw new Error(`Project review snapshot found an unsupported Git file mode: ${entry.path}`);
  }
  const blobContents = await readIndexBlobs(taskWorkspace, sourceEntries, gitConfigPath);

  const root = join(sandbox, 'review-context', 'project');
  const manifestPath = join(sandbox, 'review-context', 'manifest.json');
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

  const [headAfter, indexAfter, stagedListingAfter] = await Promise.all([
    execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], gitOptions),
    execFileAsync('git', ['write-tree'], gitOptions),
    execFileAsync('git', ['ls-files', '--stage', '-z'], gitOptions),
  ]);
  if (headAfter.stdout.toString('utf8').trim() !== headCommit || indexAfter.stdout.toString('utf8').trim() !== indexTree || !stagedListingAfter.stdout.equals(stagedListing.stdout)) {
    throw new Error('Project Git HEAD or index changed while the review snapshot was being created');
  }

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
    `Snapshot: review-context/project (manifest: review-context/manifest.json)`,
    `Source state: HEAD ${headCommit}; index tree ${indexTree}.`,
    `Coverage: ${files.length} staged Git index blobs; ${totalBytes} bytes; SHA-256 ${manifest.contentSha256}.`,
    `Excluded: ${excluded.length} Git metadata path(s); non-ignored files outside the index cause a blocked review.`,
    `Transformed data paths: ${transformed.length} (AGENTS.md and .codex names are renamed to prevent automatic instruction/config loading).`,
    'The manifest lists every copied path, hash, exclusion, and transformed name. If required context is missing, return blocked.',
  ].join('\n');
  return { root, manifestPath, summary, manifest };
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
  const maxOutputBytes = MAX_SNAPSHOT_TOTAL_BYTES + entries.length * 128 + 1024;
  const env = safeGitEnvironment(gitConfigPath);
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return await new Promise<Buffer[]>((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['cat-file', '--batch'], {
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
      try {
        resolvePromise(parseBatchBlobs(Buffer.concat(chunks, outputBytes), entries));
      } catch (error) {
        rejectPromise(error);
      }
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
    const [topLevel, commonDirectory] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: projectWorkspace,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      }),
      execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: projectWorkspace,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
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

function safeGitEnvironment(globalConfigPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.untrackedCache',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
