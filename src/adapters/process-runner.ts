import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';
import type { ProcessOutcome, ProcessRunnerOptions, RunStatus } from './types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_LOG_LIMIT = 2 * 1024 * 1024;
const TRUNCATION = '\n[Zero: output truncated at configured byte limit]\n';

/**
 * Executes a CLI without a shell. It inherits only explicitly named environment
 * variables, bounds captured output, redacts resolved secrets, and owns timeout /
 * abort termination. Arguments are never included in returned errors.
 */
export async function runProcess(options: ProcessRunnerOptions): Promise<ProcessOutcome> {
  const startedAt = Date.now();
  const maxBytes = options.maxLogBytes ?? DEFAULT_LOG_LIMIT;
  const spawnProcess = options.spawnProcess ?? ((executable, args, spawnOptions) =>
    spawn(executable, args, { ...spawnOptions, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe' }));
  let child: ChildProcess;
  try {
    child = spawnProcess(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: 'pipe',
    });
  } catch (error) {
    return failedSpawn(error);
  }

  let status: RunStatus = 'completed';
  let forcedError: string | undefined;
  let settled = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const capture = (target: Buffer[], chunk: Buffer | string, used: number): number => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const room = Math.max(0, maxBytes - used);
    if (room > 0) target.push(bytes.subarray(0, room));
    return used + bytes.length;
  };
  child.stdout?.on('data', (chunk: Buffer | string) => { stdoutBytes = capture(stdout, chunk, stdoutBytes); });
  child.stderr?.on('data', (chunk: Buffer | string) => { stderrBytes = capture(stderr, chunk, stderrBytes); });
  child.stdin?.on('error', () => { /* Early child exit may close stdin; the exit status remains authoritative. */ });
  if (options.stdin !== undefined) child.stdin?.end(options.stdin, 'utf8');
  else child.stdin?.end();

  const terminate = async (kind: 'timed_out' | 'cancelled'): Promise<void> => {
    if (settled || status !== 'completed') return;
    status = kind;
    forcedError = kind === 'timed_out' ? `Process exceeded ${options.timeoutMs} ms timeout` : 'Process was cancelled';
    await terminateTree(child);
  };

  const timer = setTimeout(() => { void terminate('timed_out'); }, Math.max(1, options.timeoutMs));
  const onAbort = (): void => { void terminate('cancelled'); };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => {
      if (status === 'completed') {
        status = 'failed';
        forcedError = `Could not start process: ${error.message}`;
      }
      resolve({ code: null, signal: null });
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  settled = true;
  clearTimeout(timer);
  options.signal?.removeEventListener('abort', onAbort);

  const redactedOut = redact(Buffer.concat(stdout).toString('utf8'), options.secrets ?? []);
  const redactedErr = redact(Buffer.concat(stderr).toString('utf8'), options.secrets ?? []);
  const out = stdoutBytes > maxBytes ? redactedOut + TRUNCATION : redactedOut;
  const err = stderrBytes > maxBytes ? redactedErr + TRUNCATION : redactedErr;
  const finalStatus = status === 'completed' && exit.code !== 0 ? 'failed' : status;
  return {
    status: finalStatus,
    exitCode: exit.code,
    stdout: out,
    stderr: err,
    ...(forcedError ? { error: forcedError } : {}),
  };
}

function failedSpawn(error: unknown): ProcessOutcome {
  return {
    status: 'failed',
    exitCode: null,
    stdout: '',
    stderr: '',
    error: `Could not start process: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function redact(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of new Set(secrets.filter((value) => value.length > 0))) {
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      return;
    } catch {
      // Fall back to the direct process handle when taskkill is unavailable.
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall through to direct child termination.
    }
  }
  try { child.kill('SIGKILL'); } catch { /* already exited */ }
}

/** Start from a clean env; only allowlisted inherited entries and resolved refs pass through. */
export function buildChildEnv(
  allowlist: string[] = [],
  secretRefs: Record<string, string> = {},
  resolveSecret?: (ref: string) => string | undefined,
  overrides: NodeJS.ProcessEnv = {},
): { env: NodeJS.ProcessEnv; secrets: string[] } {
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const secrets: string[] = [];
  for (const [key, ref] of Object.entries(secretRefs)) {
    const value = resolveSecret?.(ref);
    if (value === undefined) throw new Error(`Secret reference could not be resolved: ${ref}`);
    env[key] = value;
    secrets.push(value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  return { env, secrets };
}
