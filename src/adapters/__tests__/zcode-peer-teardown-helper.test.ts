import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ZCodeAppServerPeer } from '../zcode-app-server-peer.js';

const exec = promisify(execFile);
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const alive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 30_000); })]); }
  finally { clearTimeout(timer); }
}
async function absent(pid: number | undefined): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (alive(pid) && Date.now() < deadline) await pause(25);
  return !alive(pid);
}

type Mode = 'inflight-tree-keeps-input' | 'successful-tree-delayed-exit';
interface Result {
  mode: Mode; kills: number; fallbackKills: number; closeError?: string;
  rootPid?: number; descendantPid?: number;
  rootAbsent?: boolean; descendantAbsent?: boolean;
  cleanupRootAbsent?: boolean; cleanupDescendantAbsent?: boolean;
  events: Array<Record<string, unknown>>;
}

// Builtin replacements and the exit-observation fault stay in a dedicated
// fixture process. The OS tree operation and root/descendant PIDs are real.
async function runFixture(mode: Mode, root: string): Promise<void> {
  const actual = await realpath(root);
  assert.equal(dirname(actual), await realpath(process.cwd()));
  assert.ok(basename(actual).startsWith('.zero-zcode-helper-'));
  const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const originalExecFile = cp.execFile;
  const actualExec = promisify(originalExecFile);
  const events: Array<Record<string, unknown>> = [];
  const result: Result = { mode, kills: 0, fallbackKills: 0, events };
  const startedAt = Date.now();
  const record = (type: string, fields: Record<string, unknown> = {}) => events.push({ type, elapsedMs: Date.now() - startedAt, ...fields });
  const worktree = join(root, 'worktree'); await mkdir(worktree);
  const marker = join(root, 'descendant.json');
  const descendantEntry = join(root, 'descendant.mjs');
  await writeFile(descendantEntry, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
  const entry = join(root, 'root.mjs');
  await writeFile(entry, `import{spawn}from'node:child_process';import readline from'node:readline';import{existsSync}from'node:fs';const child=spawn(process.execPath,[${JSON.stringify(descendantEntry)}],{stdio:'ignore',windowsHide:true,detached:true});child.unref();setInterval(()=>{},1000);const rl=readline.createInterface({input:process.stdin});rl.on('close',()=>${mode === 'inflight-tree-keeps-input' ? 'process.exit(0)' : 'undefined'});rl.on('line',raw=>{const{id,method}=JSON.parse(raw);if(method==='ready')process.stdout.write(JSON.stringify({id,result:{ready:existsSync(${JSON.stringify(marker)}),root:process.pid,descendant:child.pid}})+String.fromCharCode(10));});`);
  let peer: ZCodeAppServerPeer | undefined;
  let primary: unknown;
  let rootPid: number | undefined; let descendantPid: number | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let holdExitObservation = false;
  let realExitCode: number | null = null;
  let firstKillResolve!: () => void;
  const firstKill = new Promise<void>(done => { firstKillResolve = done; });
  cp.execFile = ((tool: string, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (tool !== 'taskkill' || args[1] !== String(rootPid)) return originalExecFile(tool, args, options, callback);
    const index = ++result.kills; firstKillResolve(); record('tree_requested', { index });
    const launch = () => {
      record('tree_launched', { index, rootAlive: alive(rootPid), descendantAlive: alive(descendantPid) });
      originalExecFile(tool, args, options, (error, stdout, stderr) => {
        record('tree_result', { index, errorCode: error?.code ?? null, rootAlive: alive(rootPid), descendantAlive: alive(descendantPid) });
        if (mode === 'successful-tree-delayed-exit' && !error) {
          // Explicit fault: retain a null public exitCode for the callback's
          // microtask turn, after actual taskkill has killed the entire tree.
          holdExitObservation = true;
          callback(error, String(stdout), String(stderr));
          setImmediate(() => { holdExitObservation = false; });
        } else callback(error, String(stdout), String(stderr));
      });
    };
    if (mode === 'inflight-tree-keeps-input') setTimeout(launch, 1_000);
    else launch();
    return undefined;
  }) as typeof execFile;
  syncBuiltinESMExports();
  try {
    peer = await ZCodeAppServerPeer.launch({ entry, taskWorktree: worktree, profileMode: 'isolated', zeroDataRoot: root, dataBaseDir: join(root, 'data'), requestTimeoutMs: 10_000 });
    const observed = peer as unknown as { requestRaw(method: string, params: Record<string, unknown>): Promise<unknown>; child: ChildProcessWithoutNullStreams };
    child = observed.child;
    let ready: { ready: boolean; root: number; descendant: number } | undefined;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      ready = await observed.requestRaw('ready', {}) as typeof ready;
      if (ready?.ready) break;
      await pause(25);
    }
    assert.equal(ready?.ready, true); rootPid = ready!.root; descendantPid = ready!.descendant;
    result.rootPid = rootPid; result.descendantPid = descendantPid;
    await writeFile(join(root, 'pids.json'), JSON.stringify({ rootPid, descendantPid }) + '\n');
    assert.ok(alive(rootPid)); assert.ok(alive(descendantPid));
    child.once('close', () => { record('root_close'); });
    if (mode === 'successful-tree-delayed-exit') {
      realExitCode = child.exitCode;
      Object.defineProperty(child, 'exitCode', { configurable: true, get: () => holdExitObservation ? null : realExitCode, set: (value: number | null) => { realExitCode = value; } });
      const originalKill = child.kill;
      child.kill = function (signal?: Parameters<typeof originalKill>[0]): boolean {
        const returned = originalKill.call(this, signal);
        result.fallbackKills++;
        record('fallback_kill', { returned, observedExitCode: this.exitCode, realExitCode, rootAlive: alive(rootPid) });
        return returned;
      };
    }
    await assert.rejects(observed.requestRaw('never-answer', {}));
    await bounded(firstKill, 'failure tree teardown');
    let closeError: unknown;
    try { await bounded(peer.close(), 'peer close'); } catch (error) { closeError = error; }
    result.closeError = closeError instanceof Error ? closeError.message : closeError === undefined ? undefined : String(closeError);
    result.rootAbsent = await absent(rootPid); result.descendantAbsent = !alive(descendantPid);
    assert.equal(result.closeError, undefined, 'Successful actual tree termination must not be reported as failed');
    assert.equal(result.rootAbsent, true); assert.equal(result.descendantAbsent, true);
    assert.equal(result.kills, 1);
    assert.ok(events.some(event => event.type === 'tree_result' && event.errorCode === null && !event.rootAlive && !event.descendantAlive));
    if (mode === 'inflight-tree-keeps-input') {
      assert.ok(events.some(event => event.type === 'tree_launched' && event.rootAlive && event.descendantAlive), 'Close preserves the in-flight tree until the real tree tool starts');
    } else {
      assert.equal(result.fallbackKills, 0, 'Confirmed successful /T /F does not need a redundant root kill');
    }
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    holdExitObservation = false; cp.execFile = originalExecFile; syncBuiltinESMExports();
    for (const pid of [rootPid, descendantPid]) {
      if (!pid || !alive(pid)) continue;
      await actualExec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }).catch(() => undefined);
    }
    if (peer) await peer.close().catch(() => undefined);
    result.cleanupRootAbsent = await absent(rootPid); result.cleanupDescendantAbsent = await absent(descendantPid);
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    try {
      assert.equal(result.cleanupRootAbsent, true, 'Fixture root must not leak');
      assert.equal(result.cleanupDescendantAbsent, true, 'Fixture descendant must not leak');
    } catch (error) {
      if (primary) throw new AggregateError([primary, error], 'Teardown fixture and cleanup both failed');
      throw error;
    }
  }
}

if (process.argv[2] === '--fixture') {
  await runFixture(process.argv[3] as Mode, resolve(process.argv[4]!));
} else {
  for (const mode of ['inflight-tree-keeps-input', 'successful-tree-delayed-exit'] as const) {
    test(`ZCode teardown ${mode} confirms the OS tree result`, { skip: process.platform !== 'win32' }, async context => {
      const parent = await realpath(process.cwd());
      const root = await mkdtemp(join(parent, '.zero-zcode-helper-'));
      let primary: unknown;
      try {
        await exec(process.execPath, [fileURLToPath(import.meta.url), '--fixture', mode, root], { cwd: parent, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
        const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')) as Result;
        context.diagnostic(JSON.stringify(result));
        assert.equal(result.cleanupRootAbsent, true); assert.equal(result.cleanupDescendantAbsent, true);
      } catch (error) {
        primary = error;
        try { context.diagnostic(await readFile(join(root, 'result.json'), 'utf8')); } catch { /* A fixture startup failure can precede its receipt. */ }
        throw error;
      } finally {
        const actual = await realpath(root); assert.equal(dirname(actual), parent); assert.ok(basename(actual).startsWith('.zero-zcode-helper-'));
        let receipt: Result | undefined;
        try { receipt = JSON.parse(await readFile(join(actual, 'result.json'), 'utf8')) as Result; } catch { /* Keep unknown process custody evidence. */ }
        try {
          if (receipt?.cleanupRootAbsent === true && receipt.cleanupDescendantAbsent === true) {
            await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          } else context.diagnostic(`Retained fixture with unconfirmed process cleanup: ${actual}`);
        }
        catch (error) { if (primary) throw new AggregateError([primary, error], 'Teardown test and cleanup both failed'); throw error; }
      }
    });
  }
}
