import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
type Mode = 'duplicate-kill' | 'closed-pending-result' | 'tree-tool-failure';
interface Result {
  mode: Mode; kills: number; closeError?: string; returnedBeforeKillResult?: boolean;
  rootPid?: number; descendantPid?: number;
  rootAbsent?: boolean; descendantAbsent?: boolean; descendantAliveBeforeCleanup?: boolean;
  cleanupRootAbsent?: boolean; cleanupDescendantAbsent?: boolean;
  events: Array<Record<string, unknown>>;
}

// Run each instrumentation case in a separate Node process. Global builtin
// replacement cannot affect another test or the real worker process.
async function runFixture(mode: Mode, root: string): Promise<void> {
  const actual = await realpath(root);
  assert.equal(dirname(actual), await realpath(process.cwd()));
  assert.ok(basename(actual).startsWith('.zero-zcode-teardown-'));
  const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const originalExecFile = cp.execFile;
  const actualExec = promisify(originalExecFile);
  const events: Array<Record<string, unknown>> = [];
  const result: Result = { mode, kills: 0, events };
  const startedAt = Date.now();
  const record = (type: string, fields: Record<string, unknown> = {}) => events.push({ type, elapsedMs: Date.now() - startedAt, ...fields });
  const worktree = join(root, 'worktree'); await mkdir(worktree);
  const marker = join(root, 'descendant.json'); const nonce = randomUUID();
  const descendantEntry = join(root, 'descendant.mjs');
  await writeFile(descendantEntry, `import{writeFileSync}from'node:fs';let pulse=0;const record=()=>writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,nonce:${JSON.stringify(nonce)},pulse:++pulse}));record();setInterval(record,100);`);
  const entry = join(root, 'root.mjs');
  await writeFile(entry, `import{spawn}from'node:child_process';import readline from'node:readline';import{readFileSync}from'node:fs';const child=spawn(process.execPath,[${JSON.stringify(descendantEntry)}],{stdio:'ignore',windowsHide:true,detached:true});child.unref();setInterval(()=>{},1000);const rl=readline.createInterface({input:process.stdin});rl.on('line',raw=>{const{id,method}=JSON.parse(raw);if(method==='ready'){let ready=false;try{ready=!!JSON.parse(readFileSync(${JSON.stringify(marker)},'utf8'));}catch{}process.stdout.write(JSON.stringify({id,result:{root:process.pid,descendant:child.pid,ready}})+String.fromCharCode(10));}else if(method==='destroy-stdin'){process.stdout.write(JSON.stringify({id,result:{ok:true}})+String.fromCharCode(10));setTimeout(()=>process.stdin.destroy(),5);}});`);
  let peer: ZCodeAppServerPeer | undefined; let rootPid: number | undefined; let descendantPid: number | undefined;
  let primary: unknown;
  let releaseKillResult: (() => void) | undefined;
  let firstKillResolve!: () => void; const firstKill = new Promise<void>(done => { firstKillResolve = done; });
  let heldResultResolve!: () => void; const heldResult = new Promise<void>(done => { heldResultResolve = done; });
  let rootClosedResolve!: () => void; const rootClosed = new Promise<void>(done => { rootClosedResolve = done; });
  cp.execFile = ((executable: string, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (executable !== 'taskkill' || args[1] !== String(rootPid)) return originalExecFile(executable, args, options, callback);
    const index = ++result.kills; firstKillResolve();
    record('taskkill_requested', { index, rootAlive: alive(rootPid), descendantAlive: alive(descendantPid) });
    const launch = () => {
      // Fault control: a genuinely failed OS spawn of an unavailable tree tool.
      // The existing direct-root fallback is real; its descendant stays alive.
      const tool = mode === 'tree-tool-failure' ? join(root, 'missing-taskkill.exe') : executable;
      record('taskkill_launched', { index, toolUnavailable: mode === 'tree-tool-failure', rootAlive: alive(rootPid), descendantAlive: alive(descendantPid) });
      originalExecFile(tool, args, options, (error, stdout, stderr) => {
        record('taskkill_finished', { index, errorCode: error?.code ?? null, rootAlive: alive(rootPid), descendantAlive: alive(descendantPid) });
        const forward = () => callback(error, String(stdout), String(stderr));
        if (mode === 'closed-pending-result') { releaseKillResult = forward; heldResultResolve(); }
        else forward();
      });
    };
    if (mode === 'duplicate-kill') setTimeout(launch, index === 1 ? 1_000 : 850);
    else launch();
    return undefined;
  }) as typeof execFile;
  syncBuiltinESMExports();
  try {
    peer = await ZCodeAppServerPeer.launch({ entry, taskWorktree: worktree, profileMode: 'isolated', zeroDataRoot: root, dataBaseDir: join(root, 'data'), requestTimeoutMs: 10_000 });
    const observed = peer as unknown as { requestRaw(method: string, params: Record<string, unknown>): Promise<unknown>; child: ChildProcessWithoutNullStreams };
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
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).nonce, nonce);
    observed.child.once('close', () => { record('root_close'); rootClosedResolve(); });
    await observed.requestRaw('destroy-stdin', {}); await pause(30);
    await assert.rejects(observed.requestRaw('after-stdin-close', {}));
    await bounded(firstKill, 'initial failure teardown');
    let closeError: unknown;
    if (mode === 'closed-pending-result') {
      await bounded(heldResult, 'held real taskkill result'); await bounded(rootClosed, 'real root close');
      let returned = false;
      const closing = peer.close().then(() => { returned = true; }, error => { closeError = error; returned = true; });
      await new Promise<void>(done => setImmediate(done));
      result.returnedBeforeKillResult = returned;
      releaseKillResult!(); releaseKillResult = undefined; await bounded(closing, 'close after releasing taskkill result');
    } else {
      try { await bounded(peer.close(), 'peer close'); } catch (error) { closeError = error; }
    }
    result.closeError = closeError instanceof Error ? closeError.message : closeError === undefined ? undefined : String(closeError);
    result.rootAbsent = await absent(rootPid);
    if (mode === 'tree-tool-failure') {
      result.descendantAliveBeforeCleanup = alive(descendantPid);
      assert.equal(result.rootAbsent, true); assert.equal(result.descendantAliveBeforeCleanup, true);
      assert.match(result.closeError ?? '', /process tree termination failed/);
      assert.ok(events.some(event => event.type === 'taskkill_finished' && event.errorCode === 'ENOENT'));
    } else {
      result.descendantAbsent = await absent(descendantPid);
      assert.equal(result.rootAbsent, true); assert.equal(result.descendantAbsent, true);
      assert.equal(result.closeError, undefined, 'Successful root and descendant teardown must not fail due to a duplicate kill');
      assert.equal(result.kills, 1, 'Fail and close share exactly one OS tree termination');
      if (mode === 'closed-pending-result') assert.equal(result.returnedBeforeKillResult, false, 'Root close does not bypass an in-flight tree result');
      assert.ok(events.some(event => event.type === 'taskkill_finished' && event.errorCode === null));
    }
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    releaseKillResult?.(); cp.execFile = originalExecFile; syncBuiltinESMExports();
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
  for (const mode of ['duplicate-kill', 'closed-pending-result', 'tree-tool-failure'] as const) {
    test(`ZCode teardown ${mode} preserves actual process tree outcomes`, { skip: process.platform !== 'win32' }, async context => {
      const parent = await realpath(process.cwd());
      const root = await mkdtemp(join(parent, '.zero-zcode-teardown-'));
      let primary: unknown;
      try {
        await exec(process.execPath, [fileURLToPath(import.meta.url), '--fixture', mode, root], { cwd: parent, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
        const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')) as Result;
        context.diagnostic(JSON.stringify(result));
        assert.equal(result.cleanupRootAbsent, true); assert.equal(result.cleanupDescendantAbsent, true);
      } catch (error) {
        primary = error;
        try { context.diagnostic(await readFile(join(root, 'result.json'), 'utf8')); } catch { /* Child may fail before its receipt can be written. */ }
        throw error;
      }
      finally {
        const actual = await realpath(root); assert.equal(dirname(actual), parent); assert.ok(basename(actual).startsWith('.zero-zcode-teardown-'));
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
