import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { BaseHarnessAdapter, parseJsonLines } from '../base.js';
import type { AdapterConfig } from '../base.js';
import type { Invocation, ParsedOutput, RunContext } from '../types.js';

// These children run Node only. They never launch Codex, read auth files, or
// resolve the configured directory: the test inspects environment values only.
const script = `process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({codexHome:process.env.CODEX_HOME??null,unlisted:process.env.ZERO_TEST_UNLISTED_SECRET??null})}})+'\\n')`;
class EnvironmentFixture extends BaseHarnessAdapter {
  readonly id = 'codex' as const;
  constructor(config: AdapterConfig = {}) {
    super({ executable: process.execPath, bindings: [{ harness: 'codex', selector: 'cli_argument', verified: true, model: { id: 'fixture', provider: 'offline', modelId: 'fixture' } }], ...config });
  }
  async probe() { return { harness: this.id, available: true, models: ['fixture'] }; }
  async prepare(context: RunContext): Promise<Invocation> {
    return { harness: this.id, executable: process.execPath, args: ['-e', script], cwd: context.cwd, env: {}, parseOutput: parseJsonLines };
  }
  protected parseOutput(stdout: string, stderr: string): ParsedOutput { return parseJsonLines(stdout, stderr); }
}

test('default environment preserves explicit CODEX_HOME for probes and execution without inheriting arbitrary secrets', async (t) => {
  const parent = join(process.cwd(), 'data/verification/frontend-connections-round16');
  await mkdir(parent, { recursive: true });
  const ownedHome = await mkdtemp(join(parent, 'fake-home-'));
  const delta = relative(process.cwd(), ownedHome);
  assert.ok(!isAbsolute(delta) && !delta.startsWith('..'));
  const previousHome = process.env.CODEX_HOME;
  const previousSecret = process.env.ZERO_TEST_UNLISTED_SECRET;
  process.env.CODEX_HOME = ownedHome;
  process.env.ZERO_TEST_UNLISTED_SECRET = 'offline-canary-not-a-credential';
  t.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousSecret === undefined) delete process.env.ZERO_TEST_UNLISTED_SECRET; else process.env.ZERO_TEST_UNLISTED_SECRET = previousSecret;
  });
  const adapter = new EnvironmentFixture();
  const probe = await adapter.command(['-e', script], parent);
  assert.equal(probe.code, 0);
  assert.deepEqual(JSON.parse(parseJsonLines(probe.stdout).finalText!), { codexHome: ownedHome, unlisted: null });
  const result = await adapter.run({ taskId: 'offline-home', attemptId: 'one', harness: 'codex', model: 'fixture', role: 'route', cwd: parent, prompt: 'No model is invoked' });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(JSON.parse(result.final!), { codexHome: ownedHome, unlisted: null });
});

test('explicit environment allowlists continue to control CODEX_HOME', async () => {
  const adapter = new EnvironmentFixture({ envAllowlist: [] });
  const probe = await adapter.command(['-e', script]);
  assert.equal(probe.code, 0);
  assert.deepEqual(JSON.parse(parseJsonLines(probe.stdout).finalText!), { codexHome: null, unlisted: null });
});
