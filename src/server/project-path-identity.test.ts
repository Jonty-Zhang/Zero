import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { TaskStore } from '../core/task-store.js';
import type { LocalZeroConfig } from './config-store.js';
import { createZeroServer } from './server.js';

test('folder HTTP identity canonicalizes equivalent paths without preparing a project or conflating other directories', async () => {
  const fixtures = resolve('data/verification/boss-path-round28'); await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, 'http-')); assert.ok(root.startsWith(fixtures + sep));
  const source = join(root, 'Project Case 目录'); const other = join(root, 'Other project');
  await mkdir(source); await mkdir(other);
  await writeFile(join(source, 'large-local.bin'), Buffer.alloc(10 * 1024 * 1024 + 1));
  await writeFile(join(source, '.env'), 'must not appear in the folder response');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  const config = { async read(): Promise<LocalZeroConfig> { return { models: [], bindings: [], verifications: {},
    allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } }; }, async write() {} };
  const server = createZeroServer({ store, config, adapters: {} });
  try {
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/folders?path=${encodeURIComponent(path)}`);
      return { status: response.status, body: await response.json() as { path?: string; folders?: Array<{ name: string }> } };
    };
    const canonical = await realpath(source);
    const variants = [source, source + sep, source.replace(/\\/g, '/') + '/'];
    if (process.platform === 'win32') variants.push(source.toUpperCase(), source.toLowerCase());
    for (const variant of variants) {
      const result = await get(variant); assert.equal(result.status, 200, variant); assert.equal(result.body.path, canonical);
      assert.deepEqual(result.body.folders, []);
      assert.ok(!JSON.stringify(result.body).includes('must not appear'));
    }
    const different = await get(other); assert.equal(different.status, 200); assert.notEqual(different.body.path, canonical);
    for (const invalid of [join(root, 'does-not-exist'), join(source, 'large-local.bin')]) assert.equal((await get(invalid)).status, 400);
    for (const path of [source, other]) await assert.rejects(lstat(join(path, '.git')), { code: 'ENOENT' });
    assert.equal(await readFile(join(source, '.env'), 'utf8'), 'must not appear in the folder response');
    assert.equal((await lstat(join(source, 'large-local.bin'))).size, 10 * 1024 * 1024 + 1);
    assert.equal(store.list().length, 0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); store.close();
    assert.ok(root.startsWith(fixtures + sep)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
