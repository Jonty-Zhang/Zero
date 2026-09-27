import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChildEnv, runProcess } from '../process-runner.js';

async function waitForTrace(path: string, condition: (text: string) => boolean, timeoutMs = 3_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, 'utf8');
      if (condition(text)) return text;
    } catch { /* The trace file may not have been opened yet. */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for live lifecycle trace');
}

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

test('Codex lifecycle trace is visible before exit and stores only sanitized metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zero-codex-trace-live-'));
  const tracePath = join(directory, 'attempt.lifecycle.jsonl');
  const prompt = 'PRIVATE_PROMPT_9d3a';
  const command = 'PRIVATE_COMMAND_7f2c';
  const filePath = 'C:\\private\\repo\\secret.txt';
  const proxy = 'http://proxy-user:proxy-password@proxy.example:8080';
  const event = JSON.stringify({
    type: 'item.started',
    item: {
      id: 'PRIVATE_RAW_ITEM_ID_42', type: 'file_change', status: 'in_progress',
      text: prompt, command, path: filePath, arguments: ['--token', 'PRIVATE_ARG_66a1'], proxy,
    },
  });
  const script = `const s=${JSON.stringify(event)};process.stdout.write(s.slice(0,17));setTimeout(()=>process.stdout.write(s.slice(17)+'\\n'),30);setTimeout(()=>process.exit(0),1000)`;
  let settled = false;
  try {
    const running = runProcess({
      executable: process.execPath, args: ['-e', script], cwd: process.cwd(), env: {}, timeoutMs: 5_000,
      lifecycleTracePath: tracePath,
    }).then(result => { settled = true; return result; });
    const liveTrace = await waitForTrace(tracePath, value => value.includes('item.started'));
    assert.equal(settled, false, 'trace should be observable while codex.exe is still running');
    const record = JSON.parse(liveTrace.trim()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), ['at', 'eventType', 'itemId', 'itemType', 'status']);
    assert.match(String(record.at), /^\d{4}-\d\d-\d\dT/);
    assert.equal(record.eventType, 'item.started');
    assert.equal(record.itemType, 'file_change');
    assert.equal(record.itemId, 'i1');
    assert.equal(record.status, 'in_progress');
    for (const secret of [prompt, command, filePath, proxy, 'PRIVATE_RAW_ITEM_ID_42', 'PRIVATE_ARG_66a1']) {
      assert.ok(!liveTrace.includes(secret), `trace leaked ${secret}`);
    }
    const result = await running;
    assert.equal(result.status, 'completed');
    assert.equal(result.stdout, `${event}\n`, 'the existing final stdout result remains unchanged');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex lifecycle trace handles chunked, malformed, and oversized JSONL without copying payloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zero-codex-trace-lines-'));
  const tracePath = join(directory, 'attempt.lifecycle.jsonl');
  const secret = 'PRIVATE_OVERSIZED_PAYLOAD_3c8e';
  const started = JSON.stringify({ type: 'item.started', item: { id: 'same-id', type: 'file_change', status: 'in_progress', text: 'PRIVATE_TEXT_124a' } });
  const completed = JSON.stringify({ type: 'item.completed', item: { id: 'same-id', type: 'file_change', status: 'completed', text: 'PRIVATE_TEXT_124a' } });
  const oversized = JSON.stringify({ type: 'item.updated', item: { id: 'huge-id', type: 'file_change', text: `${secret}${'x'.repeat(70 * 1024)}` } });
  const script = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const xs=JSON.parse(input);process.stdout.write(xs[0].slice(0,11));setTimeout(()=>process.stdout.write(xs[0].slice(11)+'\\n'+xs[1]+'\\n'+xs[2]+'\\n'+xs[3]+'\\n'),20)})`;
  try {
    const result = await runProcess({
      executable: process.execPath, args: ['-e', script], cwd: process.cwd(), env: {}, timeoutMs: 5_000,
      lifecycleTracePath: tracePath, stdin: JSON.stringify([started, 'not json PRIVATE_MALFORMED_55bf', oversized, completed]),
    });
    assert.equal(result.status, 'completed');
    const text = await readFile(tracePath, 'utf8');
    const records = text.trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(records.map(record => [record.eventType, record.itemType, record.status]), [
      ['item.started', 'file_change', 'in_progress'],
      ['invalid', 'unknown', 'malformed'],
      ['invalid', 'unknown', 'oversize'],
      ['item.completed', 'file_change', 'completed'],
    ]);
    assert.equal(records[0]?.itemId, records[3]?.itemId, 'opaque item IDs correlate events within one run');
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes('PRIVATE_TEXT_124a'));
    assert.ok(!text.includes('PRIVATE_MALFORMED_55bf'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('lifecycle trace write errors do not change process results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zero-codex-trace-write-error-'));
  const event = JSON.stringify({ type: 'thread.started', thread_id: 'opaque' });
  try {
    const result = await runProcess({
      executable: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(`${event}\n`)})`],
      cwd: process.cwd(), env: {}, timeoutMs: 5_000, lifecycleTracePath: directory,
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${event}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('lifecycle trace is flushed when a running process is cancelled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zero-codex-trace-cancel-'));
  const tracePath = join(directory, 'attempt.lifecycle.jsonl');
  const controller = new AbortController();
  const event = JSON.stringify({ type: 'item.started', item: { id: 'operation-1', type: 'command_execution', status: 'in_progress' } });
  try {
    const running = runProcess({
      executable: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(`${event}\n`)});setInterval(()=>{},1000)`],
      cwd: process.cwd(), env: {}, timeoutMs: 5_000, signal: controller.signal, lifecycleTracePath: tracePath,
    });
    await waitForTrace(tracePath, value => value.includes('item.started'));
    controller.abort();
    const result = await running;
    assert.equal(result.status, 'cancelled');
    const records = (await readFile(tracePath, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.itemType, 'command_execution');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
