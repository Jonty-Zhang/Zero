import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigStore, type LocalZeroConfig } from './config-store.js';
import { createZeroServer } from './server.js';
import { TaskStore } from '../core/task-store.js';

const model = { id: 'base-model', provider: 'openai', modelId: 'base-model' };
const enrolled = { id: 'new-model', provider: 'isolated-provider', modelId: 'new-model' };
const verification = { verifiedAt: '2026-10-18T00:00:00.000Z', cliVersion: 'test-v2', requestedModel: model.modelId,
  exitCode: 0 as const, level: 'event_confirmed' as const, actualModel: model.modelId, reasoningEfforts: ['high' as const] };
const initial: LocalZeroConfig = { models: [model],
  bindings: [{ harness: 'codex', model, selector: 'cli_argument', verified: true, verifiedCliVersion: 'test-v1', reasoningEfforts: ['high'] }],
  verifications: { 'codex:base-model': { ...verification, cliVersion: 'test-v1' } },
  allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null },
  secretRefs: { PRIVATE_KEY: 'secret://preserve-me' } };
const edit = (): LocalZeroConfig => ({ ...structuredClone(initial), allocator: { kind: 'api', modelId: null, reasoningEffort: null,
  api: { baseUrl: 'https://provider.example/v1', model: 'new-router', keyEnv: 'ZERO_ROUTER_KEY' } } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class PausedStore extends ConfigStore {
  private pause: { ready: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  holdNextRead() { const pause = { ready: deferred(), release: deferred() }; this.pause = pause; return pause; }
  override async read() {
    const snapshot = await super.read();
    const pause = this.pause;
    if (pause) { this.pause = undefined; pause.ready.resolve(); await pause.release.promise; }
    return snapshot;
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zero-config-update-concurrency-'));
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(initial));
  return { root, path, store: new PausedStore(path), close: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}
const mutations = {
  enroll: { run: (store: ConfigStore) => store.registerZCodeDesktopModel(enrolled),
    check: (config: LocalZeroConfig) => assert.ok(config.models.some(item => item.id === enrolled.id)) },
  verify: { run: (store: ConfigStore) => store.markVerified('codex', model.id, verification),
    check: (config: LocalZeroConfig) => assert.equal(config.verifications['codex:base-model']?.cliVersion, 'test-v2') },
};
for (const shared of [true, false]) for (const [name, mutation] of Object.entries(mutations)) for (const first of ['settings', 'registry']) {
  test(`concurrent ${name} and settings preserve both updates (${shared ? 'same' : 'different'} instance, ${first} reads first)`, async () => {
    const f = await fixture(); const pause = f.store.holdNextRead();
    const second = shared ? f.store : new ConfigStore(f.path);
    try {
      const started = first === 'settings' ? f.store.write(edit()) : mutation.run(f.store);
      await pause.ready.promise;
      const concurrent = first === 'settings' ? mutation.run(second) : second.write(edit());
      // Before serialization, the other successful update lands while the first
      // operation still owns its old snapshot. After serialization it waits.
      await Promise.race([concurrent, delay(100)]);
      pause.release.resolve(); await Promise.all([started, concurrent]);
      const config = await f.store.read(); mutation.check(config);
      assert.equal(config.allocator.kind, 'api');
      assert.deepEqual(config.secretRefs, initial.secretRefs);
    } finally { pause.release.resolve(); await f.close(); }
  });
}

test('two model enrollments on different instances retain both tuples', async () => {
  const f = await fixture(); const pause = f.store.holdNextRead();
  try {
    const first = f.store.registerZCodeDesktopModel(enrolled); await pause.ready.promise;
    const second = new ConfigStore(f.path).registerZCodeDesktopModel({ ...enrolled, id: 'other-model', modelId: 'other-model' });
    await Promise.race([second, delay(100)]); pause.release.resolve(); await Promise.all([first, second]);
    assert.deepEqual((await f.store.read()).models.map(item => item.id).sort(), ['base-model', 'new-model', 'other-model']);
  } finally { pause.release.resolve(); await f.close(); }
});

test('every remaining configuration mutator preserves a concurrent settings save', async () => {
  const cases = [
    { run: (store: ConfigStore) => store.markDshVerified(model.id, model, 'isolated-profile', verification),
      check: (config: LocalZeroConfig) => assert.ok(config.bindings.some(item => item.harness === 'dsh')) },
    { run: (store: ConfigStore) => store.markZCodeVerified(model.id, model, resolve('isolated-config'), 'build', verification),
      check: (config: LocalZeroConfig) => assert.ok(config.bindings.some(item => item.harness === 'zcode')) },
    { run: (store: ConfigStore) => store.markZCodeAppServerVerified(model.id, model,
      { verifiedAt: verification.verifiedAt, cliVersion: 'test-v2', providerId: model.provider, modelId: model.modelId, reasoningEffort: 'high' },
      { nonce: 'isolated-nonce', echoedNonce: 'isolated-nonce', sessionEndedSuccessfully: true, peerExited: true, reasoningEffort: 'high' }),
      check: (config: LocalZeroConfig) => assert.ok(config.bindings.some(item => item.selector === 'app_server_existing_desktop')) },
    { run: (store: ConfigStore) => store.markReasoningEffortVerified('codex', model.id, 'xhigh', 'test-v1'),
      check: (config: LocalZeroConfig) => assert.ok(config.verifications['codex:base-model']?.reasoningEfforts.includes('xhigh')) },
    { run: (store: ConfigStore) => store.invalidateVersionMismatches({ codex: 'test-v2' }),
      check: (config: LocalZeroConfig) => assert.equal(config.verifications['codex:base-model'], undefined) },
  ];
  for (const mutation of cases) {
    const f = await fixture(); const pause = f.store.holdNextRead();
    try {
      const settings = f.store.write(edit()); await pause.ready.promise;
      const other = mutation.run(new ConfigStore(f.path));
      await Promise.race([other, delay(100)]); pause.release.resolve(); await Promise.all([settings, other]);
      const config = await f.store.read(); mutation.check(config); assert.equal(config.allocator.kind, 'api');
    } finally { pause.release.resolve(); await f.close(); }
  }
});

function childProcess(args: string[], dataRoot: string) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ZERO_DATA_DIR: dataRoot }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = ''; let stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; }); child.stderr!.on('data', chunk => { stderr += chunk; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveExit, reject) => {
    child.once('error', reject); child.once('close', code => resolveExit({ code, stdout, stderr }));
  });
  return { child, done };
}
async function pausedCli(root: string, id = enrolled.id) {
  const preload = join(root, `pause-${id}.mjs`);
  await writeFile(preload, `import {ConfigStore} from ${JSON.stringify(new URL('./config-store.js', import.meta.url).href)};
const read=ConfigStore.prototype.read;let paused=false;
ConfigStore.prototype.read=async function(){const snapshot=await read.call(this);if(!paused){paused=true;process.send({kind:'snapshot'});await new Promise(resolve=>process.once('message',resolve));}return snapshot;};`);
  const spawned = childProcess(['--import', pathToFileURL(preload).href, fileURLToPath(new URL('../cli.js', import.meta.url)),
    'enroll-zcode-desktop-model', id, '--provider-id', enrolled.provider, '--model-id', id], root);
  await new Promise<void>((resolveReady, reject) => {
    spawned.child.once('message', () => resolveReady());
    spawned.done.then(result => reject(new Error(`CLI exited before snapshot: ${result.stderr}`)), reject);
  });
  return spawned;
}
async function stop(child: ChildProcess) { if (child.exitCode === null && child.signalCode === null) child.kill(); }

test('real CLI enrollment and HTTP settings save preserve both accepted updates', { timeout: 15_000 }, async () => {
  const f = await fixture(); const tasks = new TaskStore();
  const server = createZeroServer({ config: f.store, store: tasks, adapters: {} });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let cli: Awaited<ReturnType<typeof pausedCli>> | undefined;
  try {
    cli = await pausedCli(f.root);
    const saving = fetch(`http://127.0.0.1:${address.port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allocator: edit().allocator, reviewer: initial.reviewer }) });
    await Promise.race([saving, delay(100)]); cli.child.send('resume');
    const [response, enrolledResult] = await Promise.all([saving, cli.done]);
    assert.equal(response.status, 200, await response.text()); assert.equal(enrolledResult.code, 0, enrolledResult.stderr);
    assert.match(enrolledResult.stdout, /Registered new-model/);
    const config = await f.store.read(); mutations.enroll.check(config); assert.equal(config.allocator.kind, 'api');
  } finally { if (cli) { await stop(cli.child); await cli.done; } server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); tasks.close(); await f.close(); }
});

test('two real CLI processes retain both enrollments', { timeout: 15_000 }, async () => {
  const f = await fixture(); let first: Awaited<ReturnType<typeof pausedCli>> | undefined;
  try {
    first = await pausedCli(f.root);
    const other = childProcess([fileURLToPath(new URL('../cli.js', import.meta.url)),
      'enroll-zcode-desktop-model', 'other-model', '--provider-id', enrolled.provider, '--model-id', 'other-model'], f.root);
    await Promise.race([other.done, delay(150)]); first.child.send('resume');
    const results = await Promise.all([first.done, other.done]);
    assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
    assert.deepEqual((await f.store.read()).models.map(item => item.id).sort(), ['base-model', 'new-model', 'other-model']);
  } finally { if (first) { await stop(first.child); await first.done; } await f.close(); }
});

test('a killed writer releases its cross-process lock without blocking the event loop', { timeout: 15_000 }, async () => {
  const f = await fixture(); let holder: Awaited<ReturnType<typeof pausedCli>> | undefined;
  try {
    holder = await pausedCli(f.root);
    let finished = false;
    const saving = new ConfigStore(f.path).write(edit()).then(() => { finished = true; });
    const started = performance.now(); await delay(100);
    assert.ok(performance.now() - started < 2_000, 'SQLite contention must yield to the event loop');
    assert.equal(finished, false, 'the live holder must retain the mutation lock');
    await stop(holder.child); await holder.done; await saving;
    assert.equal((await f.store.read()).allocator.kind, 'api');
  } finally { if (holder) { await stop(holder.child); await holder.done; } await f.close(); }
});

test('a rejected mutation releases its lock and no-op enrollment preserves legacy file bytes', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.path, 'utf8');
    await assert.rejects(f.store.registerZCodeDesktopModel({ ...model, provider: 'changed-provider' }), /different tuple/);
    assert.equal(await readFile(f.path, 'utf8'), before);
    assert.equal(await new ConfigStore(f.path).registerZCodeDesktopModel(model), 'already_registered');
    assert.equal(await readFile(f.path, 'utf8'), before);
    assert.deepEqual(await f.store.invalidateVersionMismatches({ codex: 'test-v1' }), []);
    assert.equal(await readFile(f.path, 'utf8'), before);
    await f.store.write(edit());
    const config = await f.store.read(); assert.equal(config.executionDefaults, undefined);
    assert.deepEqual(config.secretRefs, initial.secretRefs); assert.deepEqual(config.bindings, initial.bindings);
  } finally { await f.close(); }
});

test('a failed JSON replacement releases its lock and removes its temporary file', async () => {
  const f = await fixture(); const pause = f.store.holdNextRead();
  try {
    const saving = f.store.registerZCodeDesktopModel(enrolled);
    await pause.ready.promise;
    await rm(f.path); await mkdir(f.path);
    const rejected = assert.rejects(saving);
    pause.release.resolve(); await rejected;
    assert.equal((await readdir(f.root)).some(name => name.endsWith('.tmp')), false);
    await rm(f.path, { recursive: true }); await writeFile(f.path, JSON.stringify(initial));
    await new ConfigStore(f.path).registerZCodeDesktopModel(enrolled);
    mutations.enroll.check(await f.store.read());
  } finally { pause.release.resolve(); await f.close(); }
});

test('a live cross-process holder times out a waiter without revoking its lock', { timeout: 20_000 }, async () => {
  const f = await fixture(); let holder: Awaited<ReturnType<typeof pausedCli>> | undefined;
  try {
    holder = await pausedCli(f.root);
    const started = performance.now();
    await assert.rejects(new ConfigStore(f.path).write(edit()), /Timed out waiting for Zero configuration update lock/);
    assert.ok(performance.now() - started >= 9_000);
    assert.equal(holder.child.exitCode, null);
    await stop(holder.child); await holder.done;
    await f.store.write(edit()); assert.equal((await f.store.read()).allocator.kind, 'api');
  } finally { if (holder) { await stop(holder.child); await holder.done; } await f.close(); }
});

test('directory aliases share the same lock across processes', { timeout: 15_000 }, async () => {
  const f = await fixture(); const physical = join(f.root, 'physical'); const alias = join(f.root, 'alias');
  let holder: Awaited<ReturnType<typeof pausedCli>> | undefined;
  try {
    await mkdir(physical); await writeFile(join(physical, 'config.json'), JSON.stringify(initial));
    await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    holder = await pausedCli(physical);
    const saving = new ConfigStore(join(alias, 'config.json')).write(edit());
    await Promise.race([saving, delay(100)]); holder.child.send('resume');
    const [result] = await Promise.all([holder.done, saving]); assert.equal(result.code, 0, result.stderr);
    const config = await new ConfigStore(join(physical, 'config.json')).read();
    mutations.enroll.check(config); assert.equal(config.allocator.kind, 'api');
  } finally { if (holder) { await stop(holder.child); await holder.done; } await f.close(); }
});

test('concurrent enrollment creates a missing legacy configuration without losing either tuple', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'new-directory', 'config.json');
    await Promise.all([new ConfigStore(path).registerZCodeDesktopModel(enrolled),
      new ConfigStore(path).registerZCodeDesktopModel({ ...enrolled, id: 'other-model', modelId: 'other-model' })]);
    const config = await new ConfigStore(path).read();
    assert.ok(config.models.some(item => item.id === enrolled.id));
    assert.ok(config.models.some(item => item.id === 'other-model'));
    assert.deepEqual(config.bindings, []);
  } finally { await f.close(); }
});

test('real concurrent Codex verification callers retain both same-version effort proofs', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const seeded = structuredClone(initial);
    seeded.verifications['codex:base-model']!.effortEvidence = { high: { verifiedAt: verification.verifiedAt, cliVersion: 'test-v1', exitCode: 0 } };
    await writeFile(f.path, JSON.stringify(seeded));
    const script = `import {CodexAdapter} from ${JSON.stringify(new URL('../adapters/codex.js', import.meta.url).href)};
import {runBindingVerification} from ${JSON.stringify(new URL('./main.js', import.meta.url).href)};
let arrived=0;let release;const barrier=new Promise(resolve=>{release=resolve;});
CodexAdapter.prototype.probe=async()=>({harness:'codex',available:true,version:'test-v1',models:['base-model'],reasoningEfforts:['high','low','xhigh']});
CodexAdapter.prototype.run=async request=>{arrived++;if(arrived===2)release();await barrier;return {status:'completed',exitCode:0,final:request.prompt.match(/ZERO_BINDING_VERIFIED_[a-zA-Z0-9-]+/)[0],actualModel:'base-model',durationMs:1};};
await Promise.all([runBindingVerification('base-model','low'),runBindingVerification('base-model','xhigh')]);`;
    const child = childProcess(['--input-type=module', '-e', script], f.root);
    const result = await child.done; assert.equal(result.code, 0, result.stderr);
    const config = await f.store.read();
    assert.deepEqual([...config.bindings[0]!.reasoningEfforts!].sort(), ['high', 'low', 'xhigh']);
    assert.deepEqual([...config.verifications['codex:base-model']!.reasoningEfforts].sort(), ['high', 'low', 'xhigh']);
    assert.deepEqual(Object.keys(config.verifications['codex:base-model']!.effortEvidence!).sort(), ['high', 'low', 'xhigh']);
  } finally { await f.close(); }
});

test('effort proofs accumulate only for matching model tuples and matching binding and verification CLI versions', async () => {
  const f = await fixture();
  const proof = (effort: 'low' | 'xhigh', version: string) => ({ ...verification, cliVersion: version, reasoningEfforts: [effort],
    effortEvidence: { [effort]: { verifiedAt: verification.verifiedAt, cliVersion: version, exitCode: 0 as const } } });
  try {
    await f.store.markVerified('codex', model.id, proof('low', 'test-v1'));
    await f.store.markVerified('codex', model.id, proof('xhigh', 'test-v1'));
    assert.deepEqual([...(await f.store.read()).bindings[0]!.reasoningEfforts!].sort(), ['high', 'low', 'xhigh']);
    const replacement = proof('low', 'test-v1');
    replacement.effortEvidence.low!.verifiedAt = '2026-10-18T01:00:00.000Z';
    await f.store.markVerified('codex', model.id, replacement);
    assert.equal((await f.store.read()).verifications['codex:base-model']!.effortEvidence!.low!.verifiedAt, replacement.effortEvidence.low!.verifiedAt);
    await f.store.markVerified('codex', model.id, proof('low', 'test-v2'));
    let config = await f.store.read();
    assert.deepEqual(config.bindings[0]!.reasoningEfforts, ['low']);
    assert.deepEqual(Object.keys(config.verifications['codex:base-model']!.effortEvidence!), ['low']);
    const staleIncoming = proof('low', 'test-v3');
    staleIncoming.effortEvidence.high = { verifiedAt: verification.verifiedAt, cliVersion: 'test-v1', exitCode: 0 };
    await f.store.markVerified('codex', model.id, staleIncoming);
    assert.deepEqual(Object.keys((await f.store.read()).verifications['codex:base-model']!.effortEvidence!), ['low']);
    for (const corrupt of [
      (value: LocalZeroConfig) => { value.bindings[0]!.model = { ...model, provider: 'other-provider' }; },
      (value: LocalZeroConfig) => { value.bindings[0]!.verifiedCliVersion = 'different-version'; },
      (value: LocalZeroConfig) => { value.verifications['codex:base-model']!.cliVersion = 'different-version'; },
    ]) {
      config = structuredClone(initial);
      config.bindings[0]!.verifiedCliVersion = 'test-v2'; config.bindings[0]!.reasoningEfforts = ['low'];
      config.verifications['codex:base-model'] = proof('low', 'test-v2');
      corrupt(config); await writeFile(f.path, JSON.stringify(config));
      await f.store.markVerified('codex', model.id, proof('xhigh', 'test-v2'));
      config = await f.store.read();
      assert.deepEqual(config.bindings[0]!.reasoningEfforts, ['xhigh']);
      assert.deepEqual(Object.keys(config.verifications['codex:base-model']!.effortEvidence!), ['xhigh']);
    }
  } finally { await f.close(); }
});

test('a changed fresh provider or model tuple rejects the callers old Codex proof without changing bytes', async () => {
  const f = await fixture();
  try {
    for (const changed of [{ ...model, provider: 'changed-provider' }, { ...model, modelId: 'changed-model' }]) {
      await writeFile(f.path, JSON.stringify({ ...structuredClone(initial), models: [changed] }));
      const before = await readFile(f.path, 'utf8');
      await assert.rejects(f.store.markVerified('codex', model.id, verification, model), /changed during Codex verification/);
      assert.equal(await readFile(f.path, 'utf8'), before);
    }
  } finally { await f.close(); }
});

test('legacy verification records without effort lists accept fresh proof without inheriting unsupported efforts', async () => {
  const f = await fixture();
  try {
    const legacy = structuredClone(initial);
    delete (legacy.verifications['codex:base-model'] as Partial<LocalZeroConfig['verifications'][string]>).reasoningEfforts;
    await writeFile(f.path, JSON.stringify(legacy));
    await f.store.markVerified('codex', model.id, { ...verification, cliVersion: 'test-v1', reasoningEfforts: ['low'] });
    assert.deepEqual((await f.store.read()).bindings[0]!.reasoningEfforts, ['low']);
  } finally { await f.close(); }
});

test('Windows case aliases serialize the same physical configuration', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); const pause = f.store.holdNextRead();
  try {
    const enrollment = f.store.registerZCodeDesktopModel(enrolled); await pause.ready.promise;
    const saving = new ConfigStore(f.path.toUpperCase()).write(edit());
    await Promise.race([saving, delay(100)]); pause.release.resolve(); await Promise.all([enrollment, saving]);
    const config = await f.store.read(); mutations.enroll.check(config); assert.equal(config.allocator.kind, 'api');
  } finally { pause.release.resolve(); await f.close(); }
});

test('Windows short-directory aliases share the configuration update lock', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(); const pause = f.store.holdNextRead();
  try {
    const script = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System.Text;using System.Runtime.InteropServices;
public static class ShortPath { [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]public static extern uint GetShortPathName(string path,StringBuilder output,uint size); }
'@
$buffer=New-Object System.Text.StringBuilder 32768
if([ShortPath]::GetShortPathName($env:ZERO_CONFIG_ALIAS_PATH,$buffer,32768) -eq 0){exit 2}
[Console]::Write($buffer.ToString())`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, ZERO_CONFIG_ALIAS_PATH: f.root }, windowsHide: true });
    const short = stdout.trim();
    if (short.toLowerCase() === f.root.toLowerCase()) { t.skip('This volume does not expose an 8.3 alias'); return; }
    const enrollment = f.store.registerZCodeDesktopModel(enrolled); await pause.ready.promise;
    const saving = new ConfigStore(join(short, 'config.json')).write(edit());
    await Promise.race([saving, delay(100)]); pause.release.resolve(); await Promise.all([enrollment, saving]);
    const config = await f.store.read(); mutations.enroll.check(config); assert.equal(config.allocator.kind, 'api');
  } finally { pause.release.resolve(); await f.close(); }
});
