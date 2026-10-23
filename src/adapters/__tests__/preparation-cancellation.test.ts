import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BaseHarnessAdapter } from '../base.js';
import type { Invocation, ModelBinding, ParsedOutput, RunContext } from '../types.js';
import type { RunRequest } from '../../domain/types.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const binding: ModelBinding = { harness: 'dsh', selector: 'profile', profile: 'fixture', verified: true,
  model: { id: 'fixture-model', provider: 'fixture', modelId: 'local-model' } };

/** Deterministic preparation gates; the only writer is a local Node marker fixture. */
class PreparationFixture extends BaseHarnessAdapter {
  readonly id = 'dsh';
  readonly entered = gate();
  readonly released = gate();
  prepareCalls = 0;
  private held = false;
  constructor(private readonly root: string, private readonly phase: 'probe' | 'prepare') {
    super({ bindings: [binding], timeoutMs: 5_000 });
  }
  private async hold(phase: 'probe' | 'prepare') {
    if (phase !== this.phase || this.held) return;
    this.held = true;
    this.entered.release();
    await this.released.promise;
  }
  async probe() {
    await this.hold('probe');
    return { harness: this.id, available: true, models: ['fixture-model'] };
  }
  async prepare(context: RunContext): Promise<Invocation> {
    this.prepareCalls++;
    await this.hold('prepare');
    return { harness: this.id, executable: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'writer started');process.stdout.write('done')",
        join(this.root, context.attemptId + '.marker')], cwd: this.root, env: {},
      parseOutput: stdout => ({ events: [], finalText: stdout }) };
  }
  protected parseOutput(stdout: string): ParsedOutput { return { events: [], finalText: stdout }; }
}

const request = (root: string, attemptId = 'stopped'): RunRequest => ({ taskId: 'preparation-task', attemptId,
  role: 'implement', harness: 'dsh', model: 'fixture-model', cwd: root, prompt: 'Local fixture only' });
const exists = (path: string) => access(path).then(() => true, () => false);

for (const phase of ['probe', 'prepare'] as const) {
  test(`cancel during ${phase} cannot launch a writer and does not stop a sibling attempt`, async () => {
    const root = await mkdtemp(join(process.cwd(), '.zero-preparation-cancel-'));
    const adapter = new PreparationFixture(root, phase);
    let running: Promise<unknown> | undefined;
    try {
      const stopped = adapter.run(request(root));
      running = stopped;
      await adapter.entered.promise;
      const sibling = await adapter.run(request(root, 'sibling'));
      assert.equal(sibling.status, 'completed');
      assert.equal(await exists(join(root, 'sibling.marker')), true);
      await adapter.cancel('preparation-task', 'stopped');
      adapter.released.release();
      const result = await stopped;
      assert.equal(result.status, 'cancelled');
      assert.equal(result.exitCode, null);
      assert.equal(result.quota, undefined);
      assert.equal(await exists(join(root, 'stopped.marker')), false);
      assert.equal(adapter.prepareCalls, phase === 'probe' ? 1 : 2);
    } finally {
      adapter.released.release();
      if (running) await running;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('a duplicate attempt cannot replace the cancellation owner during preparation', async () => {
  const root = await mkdtemp(join(process.cwd(), '.zero-preparation-duplicate-'));
  const adapter = new PreparationFixture(root, 'prepare');
  let running: Promise<unknown> | undefined;
  try {
    const first = adapter.run(request(root));
    running = first;
    await adapter.entered.promise;
    const duplicate = await adapter.run(request(root));
    assert.equal(duplicate.status, 'failed');
    assert.match(duplicate.error ?? '', /already running/);
    await adapter.cancel('preparation-task', 'stopped');
    adapter.released.release();
    assert.equal((await first).status, 'cancelled');
    assert.equal(await exists(join(root, 'stopped.marker')), false);
  } finally {
    adapter.released.release();
    if (running) await running;
    await rm(root, { recursive: true, force: true });
  }
});

test('an explicit deadline expiring during preparation prevents writer launch', async context => {
  const root = await mkdtemp(join(process.cwd(), '.zero-preparation-deadline-'));
  const adapter = new PreparationFixture(root, 'prepare');
  let running: Promise<unknown> | undefined;
  try {
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const deadline = Date.now() + 60_000;
    const stopped = adapter.run({ ...request(root), deadline: new Date(deadline).toISOString() });
    running = stopped;
    await adapter.entered.promise;
    context.mock.timers.setTime(deadline);
    adapter.released.release();
    const result = await stopped;
    assert.equal(result.status, 'timed_out');
    assert.equal(result.exitCode, null);
    assert.equal(await exists(join(root, 'stopped.marker')), false);
  } finally {
    adapter.released.release();
    if (running) await running;
    context.mock.timers.reset();
    await rm(root, { recursive: true, force: true });
  }
});

test('an unrelated cancellation during preparation leaves the requested writer enabled', async () => {
  const root = await mkdtemp(join(process.cwd(), '.zero-preparation-control-'));
  const adapter = new PreparationFixture(root, 'prepare');
  let running: Promise<unknown> | undefined;
  try {
    const normal = adapter.run(request(root));
    running = normal;
    await adapter.entered.promise;
    await adapter.cancel('another-task', 'stopped');
    adapter.released.release();
    assert.equal((await normal).status, 'completed');
    assert.equal(await exists(join(root, 'stopped.marker')), true);
  } finally {
    adapter.released.release();
    if (running) await running;
    await rm(root, { recursive: true, force: true });
  }
});
