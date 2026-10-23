import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestRunner } from './test-runner.js';

async function fixture(run: (root: string, launches: () => number) => Promise<void>) {
  const root = await fs.mkdtemp(join(tmpdir(), 'zero-check-preparation-'));
  const originalSpawn = childProcess.spawn;
  const originalMkdir = fs.mkdir;
  const originalStat = fs.stat;
  let launches = 0;
  try {
    childProcess.spawn = (() => { launches++; throw new Error('fixture reached spawn'); }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    await run(root, () => launches);
  } finally {
    childProcess.spawn = originalSpawn;
    fs.mkdir = originalMkdir;
    fs.stat = originalStat;
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('already cancelled check keeps the original reason without spawning', async () => fixture(async (root, launches) => {
  const controller = new AbortController();
  const reason = new Error('cancelled before check');
  controller.abort(reason);
  await assert.rejects(new TestRunner().runOne({ id: 'cancelled', argv: [process.execPath, '-e', ''] }, root, { signal: controller.signal }), error => error === reason);
  assert.equal(launches(), 0);
}));

test('check cancelled while awaiting invocation resolution never reaches spawn', async () => fixture(async (root, launches) => {
  const controller = new AbortController();
  const reason = new Error('cancelled during invocation resolution');
  const running = new TestRunner().runOne({ id: 'resolve-cancel', argv: [process.execPath, '-e', ''] }, root, { signal: controller.signal });
  controller.abort(reason);
  const settled = await running.then(value => value, error => error);
  assert.equal(launches(), 0, 'a cancelled check must not reach child creation');
  assert.equal(settled, reason);
}));

test('check cancelled during log directory preparation never reaches spawn', async () => fixture(async (root, launches) => {
  const controller = new AbortController();
  const reason = new Error('cancelled during log directory preparation');
  const logs = join(root, 'logs');
  const originalMkdir = fs.mkdir;
  let entered!: () => void;
  let release!: () => void;
  const observed = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
    if (args[0] === logs) { entered(); await gate; }
    return originalMkdir(...args);
  }) as typeof fs.mkdir;
  syncBuiltinESMExports();
  const running = new TestRunner({ logDirectory: logs }).runOne({ id: 'logs-cancel', argv: [process.execPath, '-e', ''] }, root, { signal: controller.signal });
  await observed;
  controller.abort(reason);
  release();
  const settled = await running.then(value => value, error => error);
  assert.equal(launches(), 0, 'cancellation during log preparation must prevent child creation');
  assert.equal(settled, reason);
  assert.deepEqual(await fs.readdir(logs), [], 'cancelled preparation must not open log streams');
}));

test('cancellation during a failed Windows npm resolution preserves cancellation', { skip: process.platform !== 'win32' }, async () => fixture(async (root, launches) => {
  const controller = new AbortController();
  const reason = { kind: 'original cancellation reason' };
  const originalStat = fs.stat;
  let entered!: () => void;
  let release!: () => void;
  const observed = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const missingNpm = join(root, 'npm.cmd');
  fs.stat = (async (...args: Parameters<typeof fs.stat>) => {
    if (args[0] === missingNpm) { entered(); await gate; }
    return originalStat(...args);
  }) as typeof fs.stat;
  syncBuiltinESMExports();
  const running = new TestRunner().runOne({ id: 'missing-npm-cancel', argv: [missingNpm, 'test'] }, root, { signal: controller.signal });
  await observed;
  controller.abort(reason);
  release();
  const settled = await running.then(value => value, error => error);
  assert.equal(launches(), 0);
  assert.equal(settled, reason);
}));

test('uncancelled check still reaches the unchanged spawn boundary', async () => fixture(async (root, launches) => {
  const result = await new TestRunner().runOne({ id: 'normal', argv: [process.execPath, '-e', ''] }, root);
  assert.equal(launches(), 1);
  assert.equal(result.status, 'spawn_error');
  assert.equal(result.error, 'fixture reached spawn');
}));

test('uncancelled invalid Windows npm resolution remains a spawn error', { skip: process.platform !== 'win32' }, async () => fixture(async (root, launches) => {
  const result = await new TestRunner().runOne({ id: 'missing-npm', argv: [join(root, 'npm.cmd'), 'test'] }, root);
  assert.equal(launches(), 0);
  assert.equal(result.status, 'spawn_error');
  assert.match(result.error ?? '', /does not exist/);
}));
