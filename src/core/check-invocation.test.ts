import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCheckInvocation } from './check-invocation.js';
import { TestRunner } from './test-runner.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zero npm checks '));
  const bin = join(root, 'node_modules', 'npm', 'bin');
  await mkdir(bin, { recursive: true });
  for (const command of ['npm', 'npx']) {
    await writeFile(join(root, `${command}.cmd`), '@echo This shim must never be launched\r\nexit /b 77\r\n');
    await writeFile(join(bin, `${command}-cli.js`), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  }
  return { root, bin };
}

test('Windows npm/npx commands resolve to their Node entry with unchanged argument boundaries', async () => {
  const { root, bin } = await fixture();
  try {
    const companionNode = join(root, 'node.exe');
    await writeFile(companionNode, 'fixture native Node placeholder');
    for (const command of ['npm', 'npx', join(root, 'npm.cmd')]) {
      const args = ['run', 'test', '--', 'space and & percent% ! quote"'];
      const invocation = await resolveCheckInvocation([command, ...args], root, { Path: root }, 'win32');
      assert.equal(invocation.executable, companionNode);
      assert.deepEqual(invocation.args, [join(bin, command === 'npx' ? 'npx-cli.js' : 'npm-cli.js'), ...args]);
    }
    assert.deepEqual(await resolveCheckInvocation(['node', 'script.js'], root, { Path: root }, 'win32'), { executable: 'node', args: ['script.js'] });
    assert.deepEqual(await resolveCheckInvocation(['npm', 'test'], root, { PATH: root }, 'linux'), { executable: 'npm', args: ['test'] });
    await assert.rejects(resolveCheckInvocation([join(root, 'npm.bat'), 'test'], root, { PATH: root }, 'win32'), /not found|does not exist/i);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('Windows command resolution skips broken npm shims, honors PATH order, and preserves native executables', async () => {
  const { root, bin } = await fixture();
  try {
    const broken = join(root, 'broken'); await mkdir(broken);
    await writeFile(join(broken, 'npm.cmd'), '@exit /b 1');
    const native = join(root, 'native'); await mkdir(native);
    await writeFile(join(native, 'npm.exe'), 'native executable placeholder');
    const runtime = join(root, 'runtime'); await mkdir(runtime);
    await writeFile(join(runtime, 'node.exe'), 'PATH-selected Node placeholder');
    const resolved = await resolveCheckInvocation(['npm', 'test'], root, { PATH: `${broken};${root};${runtime}` }, 'win32');
    assert.deepEqual(resolved.args, [join(bin, 'npm-cli.js'), 'test']);
    assert.equal(resolved.executable, join(runtime, 'node.exe'), 'global npm shims use the Node selected by PATH');
    assert.deepEqual(await resolveCheckInvocation(['npm', '--version'], root, { PATH: `${native};${root}` }, 'win32'),
      { executable: join(native, 'npm.exe'), args: ['--version'] });
    assert.deepEqual(await resolveCheckInvocation(['npm.cmd', 'test'], root, { PATH: `${native};${root};${runtime}` }, 'win32'),
      { executable: join(runtime, 'node.exe'), args: [join(bin, 'npm-cli.js'), 'test'] }, 'an explicit .cmd name must not select npm.exe');
    await assert.rejects(resolveCheckInvocation([join(broken, 'npm.cmd'), 'test'], root, {}, 'win32'), /npm.*entry|entry.*npm/i);
    await assert.rejects(resolveCheckInvocation(['npm', 'test'], root, { PATH: root }, 'win32'), /node.*executable|executable.*node/i);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('Windows validation executes npm/npx through Node without spawning a command shell', { skip: process.platform !== 'win32' }, async () => {
  const { root } = await fixture();
  try {
    const runner = new TestRunner({ logDirectory: join(root, 'logs'), environment: { PATH: `${root};${dirname(process.execPath)}` } });
    const args = ['run', 'test', '--', 'literal & no shell'];
    for (const command of ['npm', 'npx', join(root, 'npm.cmd')]) {
      const result = await runner.runOne({ id: 'windows package check', argv: [command, ...args] }, root);
      assert.equal(result.status, 'passed', result.error);
      assert.deepEqual(JSON.parse(await readFile(result.stdoutPath!, 'utf8')), args);
      assert.deepEqual(result.argv, [command, ...args]);
    }
    const unsupported = join(root, 'custom.cmd');
    await writeFile(unsupported, '@exit /b 0');
    const failure = await runner.runOne({ id: 'unsupported shim', argv: [unsupported] }, root);
    assert.equal(failure.status, 'spawn_error', 'unsupported command shims stay shell-free and fail as a recorded check');
    assert.equal(await readFile(failure.stdoutPath!, 'utf8'), '');
    await assert.rejects(access(join(root, 'no shell')));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('Windows npm test runs a real isolated package using the installed npm entry', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'zero real npm project '));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'zero-offline-check-fixture', version: '1.0.0', private: true,
      scripts: { test: 'node --test test.cjs' } }));
    await writeFile(join(root, 'test.cjs'), "const test=require('node:test');test('offline package check',()=>console.log('NPM_CHECK_EXECUTED'));");
    await writeFile(join(root, 'user.npmrc'), ''); await writeFile(join(root, 'global.npmrc'), '');
    const runner = new TestRunner({ timeoutMs: 20_000, logDirectory: join(root, 'logs'), environment: {
      PATH: `${dirname(process.execPath)};${process.env.PATH ?? process.env.Path ?? ''}`,
      npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'user.npmrc'),
      npm_config_globalconfig: join(root, 'global.npmrc'), npm_config_update_notifier: 'false',
    } });
    const result = await runner.runOne({ id: 'real npm test', argv: ['npm', 'test'] }, root);
    assert.equal(result.status, 'passed', `${result.error ?? ''}\n${await readFile(result.stderrPath!, 'utf8')}`);
    assert.match(await readFile(result.stdoutPath!, 'utf8'), /NPM_CHECK_EXECUTED/);
    assert.deepEqual(result.argv, ['npm', 'test']);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
