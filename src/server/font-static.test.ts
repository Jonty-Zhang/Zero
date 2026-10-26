import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../core/task-store.js';
import { createZeroServer, type ConfigPort } from './server.js';

test('static WOFF2 assets retain binary bytes and advertise the font MIME type', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zero-font-static-'));
  const store = new TaskStore(':memory:');
  const config: ConfigPort = {
    async read() { throw new Error('Static assets must not access model configuration'); },
    async write() { throw new Error('Static assets must not change model configuration'); },
  };
  const server = createZeroServer({ store, config, adapters: {}, staticDir: root });
  try {
    await mkdir(join(root, 'fonts'));
    // Synthetic binary fixture: tests HTTP transport, not font decoding.
    const bytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0xff, 0x80, 0x0a, 0x0d, 0x01]);
    await writeFile(join(root, 'fonts', 'fixture.woff2'), bytes);
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Font fixture</title>');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/fonts/fixture.woff2`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'font/woff2');
    assert.equal(response.headers.get('content-length'), String(bytes.length));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy') ?? '', /font-src 'self' data:/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
