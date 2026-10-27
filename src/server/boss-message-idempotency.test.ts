import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TaskStore } from '../core/task-store.js';
import { createZeroServer, type TaskStorePort } from './server.js';
import type { BossMessage } from '../domain/types.js';

const key = 'boss-message-request-123456';
async function fixture(legacy = false) {
  const base = resolve('data/verification/boss-message-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  const database = join(root, 'tasks.sqlite');
  let store = new TaskStore(database);
  const task = store.submit({ repoPath: root, baseRef: 'HEAD', prompt: 'Build the requested project', boss: { preference: '' } });
  function serve() {
    const port: TaskStorePort = legacy ? new Proxy(store, { get(target, property) {
      if (property === 'addBossMessageIdempotent' || property === 'lookupBossMessageReceipt') return undefined;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) : store;
    return createZeroServer({ store: port, adapters: {}, config: { async read() { throw new Error('Not used'); }, async write() {} } });
  }
  let server = serve();
  async function listen() {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  }
  let url = await listen();
  async function stop() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
  const post = async (content: string, requestKey: string | null = key, taskId = task.id) => {
    const response = await fetch(`${url}/api/tasks/${taskId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...(requestKey === null ? {} : { 'x-idempotency-key': requestKey }) }, body: JSON.stringify({ content }) });
    return { status: response.status, body: await response.json() as BossMessage & { error?: string } };
  };
  const confirm = async (content: string, requestKey: string | null = key, taskId = task.id, receiptOnly: unknown = true) => {
    const response = await fetch(`${url}/api/tasks/${taskId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...(requestKey === null ? {} : { 'x-idempotency-key': requestKey }) }, body: JSON.stringify({ content, receiptOnly }) });
    return { status: response.status, body: await response.json() as BossMessage & { error?: string } };
  };
  return { task, post, confirm, database, get store() { return store; },
    async detail() { return (await fetch(`${url}/api/tasks/${task.id}`)).json() as Promise<{ bossMessageAdmission: string }>; },
    async reopen() { await stop(); store = new TaskStore(database); server = serve(); url = await listen(); },
    async close() { await stop(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

test('concurrent Boss message retries persist one exact message and replay after server restart and acceptance', async () => {
  const f = await fixture();
  try {
    const replies = await Promise.all(Array.from({ length: 4 }, () => f.post('Please verify export too')));
    assert.deepEqual(replies.map(reply => reply.status), [201, 201, 201, 201]);
    assert.equal(new Set(replies.map(reply => reply.body.id)).size, 1);
    assert.equal(f.store.bossMessages(f.task.id).length, 1);
    await f.reopen();
    f.store.claimNext('owner'); f.store.transition(f.task.id, 'running', 'reviewing', { owner: 'owner' });
    assert.deepEqual((await f.post('Please verify export too')).body, replies[0]!.body);
    assert.equal((await f.post('Please verify export too', 'different-message-request')).status, 409);
    f.store.fail(f.task.id, 'reviewing', 'Fixture finished', 'owner');
    assert.deepEqual((await f.post('Please verify export too')).body, replies[0]!.body);
    assert.equal(f.store.bossMessages(f.task.id).length, 1);
  } finally { await f.close(); }
});

test('receipt-only confirmation reads the exact durable message without events across admission changes and restart', async () => {
  const f = await fixture();
  try {
    const original = await f.post('Confirm the original 中文 requirement');
    assert.equal(original.status, 201);
    const assertReceipt = async () => {
      const events = f.store.events(f.task.id).length;
      const reply = await f.confirm('Confirm the original 中文 requirement');
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, original.body);
      assert.equal(f.store.bossMessages(f.task.id).length, 1);
      assert.equal(f.store.events(f.task.id).length, events, 'confirmation is read-only');
    };
    await assertReceipt();
    await f.reopen();
    f.store.claimNext('owner');
    await assertReceipt();
    f.store.transition(f.task.id, 'running', 'reviewing', { owner: 'owner' });
    await assertReceipt();
    f.store.fail(f.task.id, 'reviewing', 'Fixture finished', 'owner');
    await assertReceipt();
  } finally { await f.close(); }
});

test('receipt-only confirmation can never create a missing message even when the task is writable', async () => {
  const f = await fixture();
  try {
    f.store.claimNext('owner');
    assert.equal(f.store.get(f.task.id)?.status, 'running');
    const events = f.store.events(f.task.id).length;
    assert.equal((await f.confirm('The original send never arrived')).status, 409);
    assert.equal((await f.confirm('The original send never arrived', null)).status, 400);
    assert.equal((await f.confirm('The original send never arrived', key, f.task.id, false)).status, 400);
    assert.equal((await f.confirm('The original send never arrived', key, f.task.id, 'true')).status, 400);
    assert.equal(f.store.bossMessages(f.task.id).length, 0);
    assert.equal(f.store.events(f.task.id).length, events);
    assert.equal((await f.post('The original send never arrived')).status, 201, 'normal explicit send remains available');
  } finally { await f.close(); }
});

test('receipt-only confirmation preserves task/content identity and refuses unsupported legacy stores', async () => {
  const f = await fixture();
  const legacy = await fixture(true);
  try {
    await f.post('Original payload');
    const other = f.store.submit({ repoPath: '.', baseRef: 'HEAD', prompt: 'Separate task', boss: { preference: '' } });
    assert.equal((await f.confirm('Changed payload')).status, 409);
    assert.equal((await f.confirm('Original payload', key, other.id)).status, 409);
    assert.equal(f.store.bossMessages(other.id).length, 0);
    assert.equal((await legacy.confirm('No lookup support')).status, 501);
    assert.equal(legacy.store.bossMessages(legacy.task.id).length, 0);
  } finally { await f.close(); await legacy.close(); }
});

test('task detail distinguishes writable quota waiting from frozen review waiting for the message composer', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.detail()).bossMessageAdmission, 'open');
    f.store.claimNext('owner');
    f.store.pauseForQuota(f.task.id, 'owner', { retryAt: new Date(Date.now() + 60_000).toISOString(),
      reason: 'Synthetic persisted review-quota checkpoint for HTTP projection', checkpoint: { kind: 'review_quota', stage: 'review' } });
    assert.equal((await f.detail()).bossMessageAdmission, 'closed');
    assert.equal((await f.post('Must not enter frozen acceptance')).status, 409);
    const other = f.store.submit({ repoPath: '.', baseRef: 'HEAD', prompt: 'Writer quota fixture', boss: { preference: '' } });
    f.store.claimNext('other-owner');
    f.store.pauseForQuota(other.id, 'other-owner', { retryAt: new Date(Date.now() + 60_000).toISOString(),
      reason: 'Writer quota', checkpoint: { stage: 'execute' } });
    assert.equal((await f.post('Read this at the next writable boundary', 'writer-quota-http-0001', other.id)).status, 201);
  } finally { await f.close(); }
});

test('Boss message keys reject changed content or task identity; distinct intentional messages remain possible', async () => {
  const f = await fixture();
  try {
    await f.post('Preserve names');
    assert.equal((await f.post('Remove names')).status, 409);
    const other = f.store.submit({ repoPath: '.', baseRef: 'HEAD', prompt: 'Another project', boss: { preference: '' } });
    assert.equal((await f.post('Preserve names', key, other.id)).status, 409);
    assert.equal(f.store.bossMessages(other.id).length, 0);
    assert.equal((await f.post('Preserve names', 'fresh-message-request-123')).status, 201);
    await f.post('Preserve names', null); await f.post('Preserve names', null);
    assert.equal(f.store.bossMessages(f.task.id).length, 4);
    assert.equal((await f.post('Invalid key', 'bad')).status, 400);
    assert.equal(f.store.bossMessages(f.task.id).length, 4);
  } finally { await f.close(); }
});

test('Boss stores without durable message requests reject keyed delivery rather than silently duplicating it', async () => {
  const f = await fixture(true);
  try {
    assert.equal((await f.post('Need a durable acknowledgement')).status, 501);
    assert.equal(f.store.bossMessages(f.task.id).length, 0);
    assert.equal((await f.post('Legacy delivery remains supported', null)).status, 201);
  } finally { await f.close(); }
});
