import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const pending = new Map<string, Promise<PreparedProject>>();
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 20_000;
const exclusions = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials', 'credentials.json',
  'auth.json', '.npmrc', '.netrc', '.git-credentials',
  'secrets.json', 'secrets.yaml', 'secrets.yml', 'tokens.json', 'client_secret*.json', '*-credentials.json',
  '.aws/', '.ssh/', '.gnupg/', '.azure/', '.codex/', '.kube/', '.docker/',
  'node_modules/', '.venv/', 'venv/', '__pycache__/', '.cache/', '.zero/',
  'dist/', 'build/', 'coverage/', '.next/', '.nuxt/',
];

export class ProjectFolderError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface PreparedProject { path: string; repoPath: string; initialized: boolean; baseRef?: string }

function pathInput(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value) || !isAbsolute(value.trim())) {
    throw new ProjectFolderError('项目文件夹必须是有效的绝对路径');
  }
  return resolve(value.trim());
}

async function directory(path: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new ProjectFolderError('文件夹不存在、无法访问或不是普通目录');
  return realpath(path);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)/i.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}

async function git(path: string, args: string[], extraEnv?: NodeJS.ProcessEnv) {
  return execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', ...args], { cwd: path, env: { ...gitEnvironment(), ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
}

function privatePath(name: string): boolean {
  const parts = name.toLowerCase().split('/');
  const leaf = parts.at(-1)!;
  return parts.some(part => ['.aws', '.ssh', '.gnupg', '.azure', '.codex', '.kube', '.docker', '.git'].includes(part))
    || /^\.env(?:\.|$)/.test(leaf) || /\.(?:pem|key|p12|pfx|keystore)$/.test(leaf)
    || /^(?:secrets\.(?:json|ya?ml)|tokens\.json|client_secret.*\.json|.*-credentials\.json)$/.test(leaf)
    || ['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials', 'credentials.json', 'auth.json', '.npmrc', '.netrc', '.git-credentials'].includes(leaf);
}

/** Lists names only. Never reads file contents or follows linked child directories. */
export async function listProjectFolders(value: unknown = process.cwd()) {
  const path = await directory(pathInput(value));
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(path, { withFileTypes: true });
  const folders: Array<{ name: string; path: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const candidate = join(path, entry.name);
    const info = await lstat(candidate).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const canonical = await realpath(candidate).catch(() => undefined);
    if (!canonical || dirname(canonical) !== path) continue;
    folders.push({ name: entry.name, path: canonical });
    if (folders.length === 500) break;
  }
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, folders };
}

/** User-selected folders receive local history only; no remote is created or contacted. */
export async function prepareProjectFolder(value: unknown, create = false): Promise<PreparedProject> {
  const requested = pathInput(value);
  if (create) {
    const parent = await directory(dirname(requested));
    const child = relative(parent, requested);
    // Creation is a single, explicit final component; existing content is never replaced.
    if (!child || child.includes(sep) || child === '..' || child.includes(':') || /[. ]$/.test(child) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(child)) {
      throw new ProjectFolderError('新文件夹名称无效');
    }
    try { await mkdir(join(parent, child)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ProjectFolderError('无法创建项目文件夹'); }
  }
  const path = await directory(requested);
  const previous = pending.get(path);
  if (previous) return previous;
  const operation = prepare(path);
  pending.set(path, operation);
  try { return await operation; }
  finally { if (pending.get(path) === operation) pending.delete(path); }
}

async function prepare(path: string): Promise<PreparedProject> {
  const markerPath = join(path, '.git', 'zero-project-initialization.json');
  const metadata = await lstat(join(path, '.git')).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ProjectFolderError('无法检查项目的版本记录');
  });
  if (metadata?.isSymbolicLink()) throw new ProjectFolderError('项目 .git 不能是符号链接');
  let allowedIndexTrees: string[] = [];
  let preserveIndex = false;
  let previousHead: string | undefined;
  let gitDirectory = join(path, '.git');
  if (metadata) {
    const top = await git(path, ['rev-parse', '--show-toplevel']).catch(() => undefined);
    if (!top || await realpath(top.stdout.trim()).catch(() => '') !== path) throw new ProjectFolderError('所选文件夹的 Git 工作区无效');
    const head = await git(path, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => undefined);
    if (head) {
      previousHead = head.stdout.trim();
      preserveIndex = true;
      gitDirectory = (await git(path, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    }
    // Existing unborn repositories use a completely separate index. Their index
    // bytes and local configuration remain untouched while local history begins.
    const marker = !previousHead ? await readFile(markerPath, 'utf8').then(text => JSON.parse(text) as { path?: unknown; allowedIndexTrees?: unknown }).catch(() => undefined) : undefined;
    if (marker?.path === path && Array.isArray(marker.allowedIndexTrees) && marker.allowedIndexTrees.every(value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value))) {
      allowedIndexTrees = marker.allowedIndexTrees as string[];
      const currentTree = (await git(path, ['write-tree'])).stdout.trim();
      if (!allowedIndexTrees.includes(currentTree)) preserveIndex = true;
    } else preserveIndex = true;
  } else {
    // An explicit init creates a nested repository, never implicitly adopts a parent.
    await git(path, ['init', '--initial-branch=main', '--template=']);
    const infoPath = join(path, '.git', 'info');
    await mkdir(infoPath, { recursive: true });
    await writeFile(join(infoPath, 'exclude'), `# Zero local-only private-file and generated-file exclusions\n${exclusions.join('\n')}\n`, { flag: 'wx' });
    allowedIndexTrees = [(await git(path, ['write-tree'])).stdout.trim()];
    await writeFile(markerPath, JSON.stringify({ path, allowedIndexTrees }), { flag: 'wx' });
  }
  const indexPath = join(gitDirectory, `zero-initial-index-${randomUUID()}`);
  const indexEnv = { GIT_INDEX_FILE: indexPath };
  const branchRef = previousHead ? undefined : (await git(path, ['symbolic-ref', 'HEAD'])).stdout.trim();
  if (branchRef !== undefined && (!branchRef.startsWith('refs/heads/') || /[\0\r\n]/.test(branchRef))) throw new ProjectFolderError('项目 HEAD 不是有效的本地分支');
  try {
    const tracked = previousHead ? [...(await git(path, ['ls-tree', '-r', '--name-only', '-z', previousHead])).stdout.split('\0'),
      ...(await git(path, ['ls-files', '--cached', '-z'])).stdout.split('\0')] : [];
    const candidates = [...new Set([...tracked, ...(await git(path, ['ls-files', '--others', '--exclude-standard', '-z'], indexEnv)).stdout.split('\0')])].filter(Boolean);
    const trackedNames = new Set(tracked);
    const files: Array<{ name: string; mode: string }> = [];
    let total = 0;
    for (const name of candidates) {
      if (!name || name.includes('\\') || privatePath(name) || name.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) continue;
      const target = resolve(path, name);
      if (!target.startsWith(path + sep)) continue;
      const info = await lstat(target).catch(error => {
        if (trackedNames.has(name) && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new ProjectFolderError(`无法读取 ${name}，未创建不完整快照`);
      });
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (info.size > MAX_FILE_BYTES) throw new ProjectFolderError(`文件 ${name} 超过 10 MiB，未创建不完整快照；请将大型生成文件加入 .gitignore 后重试`);
      if (await realpath(target).catch(() => '') !== target) continue;
      if (files.length >= MAX_FILES || total + info.size > MAX_TOTAL_BYTES) throw new ProjectFolderError('项目过大，未创建初始快照；请排除依赖或大型生成文件后重试');
      files.push({ name, mode: info.mode & 0o111 ? '100755' : '100644' }); total += info.size;
    }
    // Hash raw regular-file bytes. git add can execute repository-defined clean
    // filters; preparing a folder must not run those external programs.
    for (let offset = 0; offset < files.length; offset += 100) {
      const batch = files.slice(offset, offset + 100);
      const hashes = (await git(path, ['hash-object', '-w', '--no-filters', '--', ...batch.map(file => file.name)])).stdout.trim().split(/\r?\n/);
      if (hashes.length !== batch.length || hashes.some(hash => !/^[a-f0-9]{40,64}$/.test(hash))) throw new ProjectFolderError('无法建立可靠的项目文件快照');
      const args = ['update-index', '--add'];
      for (let index = 0; index < batch.length; index++) args.push('--cacheinfo', `${batch[index]!.mode},${hashes[index]},${batch[index]!.name}`);
      await git(path, args, indexEnv);
    }
    const tree = (await git(path, ['write-tree'], indexEnv)).stdout.trim();
    if (previousHead && (await git(path, ['rev-parse', `${previousHead}^{tree}`])).stdout.trim() === tree) {
      return { path, repoPath: path, initialized: false, baseRef: previousHead };
    }
    const commit = (await git(path, ['-c', 'user.name=Zero', '-c', 'user.email=zero@localhost', 'commit-tree', tree,
      ...(previousHead ? ['-p', previousHead] : []), '-m', 'Initialize local Zero project snapshot'])).stdout.trim();
    if (previousHead) {
      // A private ref retains the selected current files while the task waits in
      // the queue. Never advance the user's branch or rewrite their index.
      const baseRef = `refs/zero/project-snapshots/${randomUUID()}`;
      await git(path, ['update-ref', baseRef, commit, '0'.repeat(commit.length)]);
      return { path, repoPath: path, initialized: false, baseRef };
    }
    if ((await git(path, ['symbolic-ref', 'HEAD'])).stdout.trim() !== branchRef) throw new ProjectFolderError('项目分支在准备期间已变更，请重试');
    if (!preserveIndex) {
      const currentTree = (await git(path, ['write-tree'])).stdout.trim();
      if (!allowedIndexTrees.includes(currentTree)) throw new ProjectFolderError('项目索引在准备期间已变更，未覆盖');
      await writeFile(markerPath, JSON.stringify({ path, allowedIndexTrees: [...new Set([...allowedIndexTrees, tree])] }));
      await git(path, ['read-tree', tree]);
    }
    await git(path, ['update-ref', branchRef!, commit, '0'.repeat(commit.length)]);
    if (!preserveIndex) await unlink(markerPath);
    return { path, repoPath: path, initialized: true };
  } finally { await unlink(indexPath).catch(() => {}); }
}
