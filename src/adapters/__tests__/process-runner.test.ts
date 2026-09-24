import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChildEnv, runProcess } from '../process-runner.js';

test('child environment inherits only allowlisted keys and resolves secret references', () => {
  const oldPath = process.env.ZERO_TEST_PATH;
  const oldToken = process.env.ZERO_TEST_TOKEN;
  process.env.ZERO_TEST_PATH = 'allowed-path';
  process.env.ZERO_TEST_TOKEN = 'must-not-inherit';
  try {
    const built = buildChildEnv(['ZERO_TEST_PATH'], { API_TOKEN: 'vault://token' }, (ref) => ref === 'vault://token' ? 'secret-value' : undefined);
    assert.deepEqual(built.env, { ZERO_TEST_PATH: 'allowed-path', API_TOKEN: 'secret-value' });
    assert.deepEqual(built.secrets, ['secret-value']);
  } finally {
    if (oldPath === undefined) delete process.env.ZERO_TEST_PATH; else process.env.ZERO_TEST_PATH = oldPath;
    if (oldToken === undefined) delete process.env.ZERO_TEST_TOKEN; else process.env.ZERO_TEST_TOKEN = oldToken;
  }
});

test('child environment forwards proxy settings and redacts URL credentials from CLI output', async () => {
  const oldHttpsProxy = process.env.HTTPS_PROXY;
  const oldNoProxy = process.env.NO_PROXY;
  const proxy = 'http://proxy-user:p%40ss@proxy.example:8080';
  process.env.HTTPS_PROXY = proxy;
  process.env.NO_PROXY = 'localhost,127.0.0.1';
  try {
    const built = buildChildEnv(['HTTPS_PROXY', 'NO_PROXY']);
    assert.equal(built.env.HTTPS_PROXY, proxy);
    assert.equal(built.env.NO_PROXY, 'localhost,127.0.0.1');
    const result = await runProcess({
      executable: process.execPath,
      args: ['-e', `process.stderr.write(${JSON.stringify('proxy-user p@ss')})`],
      cwd: process.cwd(), env: built.env, secrets: built.secrets, timeoutMs: 5_000,
    });
    assert.equal(result.stderr, '[REDACTED] [REDACTED]');
    assert.ok(!JSON.stringify(result).includes('proxy-user'));
    assert.ok(!JSON.stringify(result).includes('p@ss'));
  } finally {
    if (oldHttpsProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = oldHttpsProxy;
    if (oldNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = oldNoProxy;
  }
});

test('child environment fails closed when a secret reference cannot be resolved', () => {
  assert.throws(() => buildChildEnv([], { API_TOKEN: 'vault://missing' }, () => undefined), /could not be resolved/);
});

test('runner uses direct argv and redacts secrets even when output is chunked', async () => {
  const secret = 'very-secret-token';
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(secret.slice(0, 6))});setTimeout(()=>process.stdout.write(${JSON.stringify(secret.slice(6))}),5)`],
    cwd: process.cwd(), env: {}, timeoutMs: 5_000, secrets: [secret],
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '[REDACTED]');
  assert.ok(!result.stdout.includes(secret));
});

test('runner streams input over stdin without placing it in argv', async () => {
  const prompt = `long prompt ${'context '.repeat(5000)}`;
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>process.stdout.write(String(input.length)))"],
    cwd: process.cwd(), env: {}, stdin: prompt, timeoutMs: 5_000,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.stdout, String(prompt.length));
  assert.ok(!JSON.stringify(result).includes(prompt));
});

test('runner bounds log size and reports truncation', async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('abcdefghij')"],
    cwd: process.cwd(), env: {}, timeoutMs: 5_000, maxLogBytes: 4,
  });
  assert.equal(result.status, 'completed');
  assert.match(result.stdout, /^abcd\n\[Zero: output truncated/);
});

test('runner terminates a process that exceeds its time budget', async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(), env: {}, timeoutMs: 100,
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.exitCode, null);
  assert.match(result.error ?? '', /exceeded 100 ms/);
});

test('runner cancels on AbortSignal', async () => {
  const controller = new AbortController();
  const promise = runProcess({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(), env: {}, timeoutMs: 5_000, signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const result = await promise;
  assert.equal(result.status, 'cancelled');
  assert.match(result.error ?? '', /cancelled/);
});

test('runner reports spawn errors without echoing command arguments', async () => {
  const result = await runProcess({
    executable: 'zero-definitely-missing-executable', args: ['--token', 'not-for-logs'],
    cwd: process.cwd(), env: {}, timeoutMs: 1_000,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /Could not start process/);
  assert.ok(!JSON.stringify(result).includes('not-for-logs'));
});
