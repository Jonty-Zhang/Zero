import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from './task-store.js';

const key = 'durable-boss-message-request';
async function fixture() {
  const base = resolve('data/verification/boss-message-store-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-')); const database = join(root, 'queue.sqlite');
  const store = new TaskStore(database);
  const task = store.submit({ repoPath: '.', baseRef: 'HEAD', prompt: 'Implement a working project', boss: { preference: '' } });
  return { database, store, task, async close() { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test('message delivery receipt failure rolls back the message event and task timestamp, and permits an exact retry', async () => {
  const f = await fixture(); const sql = new DatabaseSync(f.database);
  try {
    const eventsBefore = f.store.events(f.task.id);
    sql.exec("CREATE TRIGGER reject_message_receipt BEFORE INSERT ON boss_message_requests BEGIN SELECT RAISE(ABORT, 'receipt IO failure'); END;");
    assert.throws(() => f.store.addBossMessageIdempotent(f.task.id, 'Verify exports', key), /receipt IO failure/);
    assert.deepEqual(f.store.events(f.task.id), eventsBefore);
    assert.equal(f.store.get(f.task.id)?.updatedAt, f.task.updatedAt);
    assert.equal(sql.prepare('SELECT count(*) AS count FROM boss_message_requests').get()?.count, 0);
    sql.exec('DROP TRIGGER reject_message_receipt');
    const saved = f.store.addBossMessageIdempotent(f.task.id, 'Verify exports', key);
    assert.deepEqual(f.store.bossMessages(f.task.id), [saved]);
  } finally { sql.close(); await f.close(); }
});

test('independent SQLite connections replay the exact receipt after cancellation without admitting a new requirement', async () => {
  const f = await fixture(); const other = new TaskStore(f.database);
  try {
    const saved = f.store.addBossMessageIdempotent(f.task.id, '  Preserve export names  ', key);
    assert.deepEqual(other.addBossMessageIdempotent(f.task.id, 'Preserve export names', key), saved);
    other.claimNext('owner');
    other.requestTaskCancellation(f.task.id, 'owner', other.get(f.task.id)!.claimGenerationId!);
    assert.deepEqual(f.store.addBossMessageIdempotent(f.task.id, 'Preserve export names', key), saved);
    assert.throws(() => other.addBossMessageIdempotent(f.task.id, 'A new requirement', 'new-message-request-123'), /任务已停止/);
    assert.equal(other.bossMessages(f.task.id).length, 1);
    assert.throws(() => f.store.addBossMessage(f.task.id, 'boss', 'Preserve export names', { owner: 'owner', requestKey: key }), /Only user messages/);
  } finally { other.close(); await f.close(); }
});

test('the reliable message API never silently falls back to unkeyed delivery for missing or invalid keys', () => {
  const store = new TaskStore();
  try {
    const task = store.submit({ repoPath: '.', baseRef: 'HEAD', prompt: 'Implement a project', boss: { preference: '' } });
    for (const invalid of [undefined, null, '', 'short', 'x'.repeat(129), ['array-message-request']]) {
      assert.throws(() => store.addBossMessageIdempotent(task.id, 'Preserve the result', invalid as unknown as string), /idempotency/i);
    }
    assert.equal(store.bossMessages(task.id).length, 0);
  } finally { store.close(); }
});
