import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessAdapter, RunRequest } from '../../domain/types.js';
import { OpenAICompatibleCoordinator } from '../openai-compatible-coordinator.js';
import { TaskRouter } from '../router.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('cancellation during schema loading prevents the API request from starting', async () => {
  const root = await mkdtemp(join(process.cwd(), '.zero-api-cancel-schema-'));
  const previous = process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY;
  process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY = 'local-fixture-only';
  try {
    const schema = join(root, 'schema.json');
    await writeFile(schema, '{}');
    let requests = 0;
    const adapter = new OpenAICompatibleCoordinator({ baseUrl: 'https://fixture.invalid', model: 'router',
      keyEnv: 'ZERO_ROUTE_CANCEL_FIXTURE_KEY', fetch: async () => { requests++; throw new Error('Cancelled preparation must not fetch'); } });
    const running = adapter.run({ ...request('schema'), outputSchemaPath: schema });
    await adapter.cancel('task', 'schema');
    assert.equal((await bounded(running)).status, 'cancelled');
    assert.equal(requests, 0);
  } finally {
    if (previous === undefined) delete process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY;
    else process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('a route cancelled during coordinator preparation never launches that coordinator', async () => {
  const root = await mkdtemp(join(process.cwd(), '.zero-route-cancel-prepare-'));
  const entered = gate();
  const released = gate();
  let requests = 0;
  let running: Promise<unknown> | undefined;
  try {
    const api: HarnessAdapter = { id: 'api-coordinator', async probe() {
      entered.release(); await released.promise;
      return { harness: this.id, available: true, models: ['router'] };
    }, async run() { requests++; throw new Error('Cancelled route must not run'); } };
    const unused: HarnessAdapter = { id: 'codex', async probe() { throw new Error('Unused'); }, async run() { throw new Error('Unused'); } };
    const router = new TaskRouter({ api, codex: unused, coordinatorKind: 'api', coordinatorModel: 'router', cwd: root,
      artifactDir: root, getCandidates: () => [{ bindingId: 'fake:writer', harness: 'fake', model: 'writer',
        verified: true, available: true, healthy: true, reasoningEfforts: [], capabilities: ['code'] }] });
    const controller = new AbortController();
    running = router.route({ id: 'task', repoPath: root, baseRef: 'main', prompt: 'A cancelled route', status: 'running',
      createdAt: '', updatedAt: '', revisionCount: 0 }, { cwd: root, baseCommit: 'a'.repeat(40), checks: [], revision: 0,
      signal: controller.signal });
    const rejected = assert.rejects(running, /cancelled during preparation/);
    await bounded(entered.promise);
    controller.abort(new Error('cancelled during preparation'));
    released.release();
    await bounded(rejected);
    assert.equal(requests, 0);
  } finally {
    released.release();
    if (running) await running.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

for (const phase of ['headers', 'body'] as const) {
  test(`API coordinator preserves timeout classification during ${phase}`, async () => {
    const previous = process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY;
    process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY = 'local-fixture-only';
    try {
      const adapter = new OpenAICompatibleCoordinator({ baseUrl: 'https://fixture.invalid', model: 'router',
        keyEnv: 'ZERO_ROUTE_CANCEL_FIXTURE_KEY', timeoutMs: 30,
        fetch: async (_url, init) => {
          const signal = init!.signal!;
          if (phase === 'headers') return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return new Response(new ReadableStream({ start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          } }));
        } });
      const result = await bounded(adapter.run(request('timeout')));
      assert.equal(result.status, 'timed_out');
      assert.match(result.error ?? '', /timed out/);
    } finally {
      if (previous === undefined) delete process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY;
      else process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY = previous;
    }
  });
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('API request did not stop after cancellation')), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}
const request = (attemptId: string): RunRequest => ({ taskId: 'task', attemptId, role: 'route', cwd: '.',
  prompt: attemptId, harness: 'api-coordinator', model: 'router' });

for (const phase of ['headers', 'body'] as const) {
  test(`API coordinator cancellation interrupts ${phase} and leaves another attempt running`, async () => {
    const previous = process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY;
    process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY = 'local-fixture-only';
    const firstEntered = gate();
    const secondEntered = gate();
    const aborted = gate();
    const responses = new Map<string, () => void>();
    const signals = new Map<string, AbortSignal>();
    const running: Array<Promise<unknown>> = [];
    try {
      const adapter: HarnessAdapter = new OpenAICompatibleCoordinator({ baseUrl: 'https://fixture.invalid/v1',
        model: 'router', keyEnv: 'ZERO_ROUTE_CANCEL_FIXTURE_KEY', timeoutMs: 30_000,
        fetch: async (_url, init) => {
          const id = JSON.parse(String(init?.body)).messages[0].content as string;
          const signal = init!.signal!;
          signals.set(id, signal);
          const entered = id === 'first' ? firstEntered : secondEntered;
          const payload = JSON.stringify({ choices: [{ message: { content: 'valid fixture response' } }] });
          if (phase === 'headers') return new Promise<Response>((resolve, reject) => {
            const onAbort = () => { aborted.release(); reject(signal.reason); };
            signal.addEventListener('abort', onAbort, { once: true });
            responses.set(id, () => { responses.delete(id); signal.removeEventListener('abort', onAbort); resolve(new Response(payload)); });
            entered.release();
          });
          return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            const onAbort = () => { aborted.release(); controller.error(signal.reason); };
            signal.addEventListener('abort', onAbort, { once: true });
            responses.set(id, () => {
              responses.delete(id);
              signal.removeEventListener('abort', onAbort);
              if (!signal.aborted) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); }
            });
            entered.release();
          } }));
        } });
      const first = adapter.run(request('first')); running.push(first);
      const second = adapter.run(request('second')); running.push(second);
      await bounded(Promise.all([firstEntered.promise, secondEntered.promise]));
      await adapter.cancel?.('other-task', 'first');
      assert.equal(signals.get('first')?.aborted, false);
      await adapter.cancel?.('task', 'first');
      await bounded(aborted.promise);
      assert.equal((await bounded(first)).status, 'cancelled');
      assert.equal(signals.get('second')?.aborted, false);
      responses.get('second')!();
      const result = await bounded(second);
      assert.equal(result.status, 'completed');
      assert.equal(result.final, 'valid fixture response');
      await adapter.cancel?.('task', 'second');
      assert.equal(signals.get('second')?.aborted, false, 'finished requests must be removed from cancellation tracking');
    } finally {
      for (const release of responses.values()) release();
      await Promise.allSettled(running);
      if (previous === undefined) delete process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY;
      else process.env.ZERO_ROUTE_CANCEL_FIXTURE_KEY = previous;
    }
  });
}
