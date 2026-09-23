import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TrustedCodexCwdOptions {
  artifactRoot: string;
  purpose: 'route' | 'review';
  /** The repository or worktree whose AGENTS.md and content must not be loaded. */
  taskWorkspace: string;
}

export interface TrustedCodexCwd {
  cwd: string;
  dispose(): Promise<void>;
}

/**
 * Creates a fresh empty Git repository below artifactRoot for a coordinator/reviewer
 * Codex session. It refuses paths overlapping the task workspace and any AGENTS.md
 * in the cwd ancestor chain, then removes only the generated directory on dispose.
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
  await assertNoAgentInstructions(sandboxPath);
  let createdPath: string | undefined;
  try {
    await mkdir(templatePath, { recursive: false, mode: 0o700 });
    await writeFile(globalConfigPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await mkdir(sandboxPath, { recursive: false, mode: 0o700 });
    createdPath = await realpath(sandboxPath);
    if (createdPath !== sandboxPath || !isWithin(artifactRoot, createdPath)) throw new Error('Trusted Codex cwd resolved outside artifactRoot');
    if ((await readdir(createdPath)).length !== 0) throw new Error('Trusted Codex cwd must start empty');
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main'], {
      cwd: createdPath,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: safeGitEnvironment(globalConfigPath),
    });
    await rm(templatePath, { recursive: true, force: false });
    await rm(globalConfigPath, { force: false });
    await assertNoAgentInstructions(createdPath);
    return {
      cwd: createdPath,
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

export function isWithin(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function assertNoAgentInstructions(cwd: string): Promise<void> {
  let current = cwd;
  for (;;) {
    const agentFile = join(current, 'AGENTS.md');
    try {
      await access(agentFile, constants.F_OK);
      throw new Error(`Trusted Codex cwd has an AGENTS.md in its ancestor chain: ${agentFile}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Trusted Codex cwd has an AGENTS.md')) throw error;
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function safeGitEnvironment(globalConfigPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfigPath, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
