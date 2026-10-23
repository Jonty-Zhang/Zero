import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZCodeAppServerPeer, type ZCodeAppServerPeerOptions } from '../zcode-app-server-peer.js';

// Observe the actual launch boundary without allowing the fixture to start a CLI.
async function atSpawn(mode: 'isolated' | 'existing-desktop', run: (options: ZCodeAppServerPeerOptions, launches: () => number, marker: Error) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'zero-peer-preparation-'));
  const originalSpawn = childProcess.spawn;
  const marker = new Error('uncancelled launch reached its spawn boundary');
  let launches = 0;
  try {
    const worktree = join(root, 'worktree');
    const cliDir = join(root, 'resources', 'glm');
    await mkdir(worktree, { recursive: true });
    await mkdir(cliDir, { recursive: true });
    const entry = join(cliDir, 'cli.mjs');
    await writeFile(entry, '// Local launch-boundary fixture; never executed.');
    childProcess.spawn = (() => { launches++; throw marker; }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    await run({ entry, taskWorktree: worktree, profileMode: mode,
      ...(mode === 'isolated' ? { zeroDataRoot: join(root, 'data'), dataBaseDir: join(root, 'data', 'profile') } : {}) }, () => launches, marker);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
}

for (const mode of ['isolated', 'existing-desktop'] as const) {
  for (const phase of ['before entry', 'during filesystem preparation'] as const) {
    test(`${mode} peer cancelled ${phase} never reaches spawn`, async () => atSpawn(mode, async (options, launches) => {
      const controller = new AbortController();
      const reason = new Error('fixture launch cancelled');
      if (phase === 'before entry') controller.abort(reason);
      const running = ZCodeAppServerPeer.launch({ ...options, signal: controller.signal });
      // launch first awaits access(entry); abort before its continuation resumes.
      if (phase === 'during filesystem preparation') controller.abort(reason);
      const error = await running.then(() => undefined, caught => caught);
      assert.equal(launches(), 0, 'an aborted request must not create a child');
      assert.equal(error, reason);
    }));
  }

  test(`${mode} peer without cancellation still reaches the same spawn boundary`, async () => atSpawn(mode, async (options, launches, marker) => {
    await assert.rejects(ZCodeAppServerPeer.launch(options), error => error === marker);
    assert.equal(launches(), 1);
  }));
}
