import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../codex.js';
import { DshAdapter } from '../dsh.js';
import { ZCodeAdapter } from '../zcode.js';
import { BaseHarnessAdapter, parseJsonLines } from '../base.js';
import type { AdapterConfig } from '../base.js';
import type { Invocation, ModelBinding, ParsedOutput, RunContext } from '../types.js';

const codexBinding: ModelBinding = {
  harness: 'codex', selector: 'cli_argument', verified: true,
  model: { id: 'gpt-main', provider: 'openai', modelId: 'gpt-5-codex' },
};
const dshBinding: ModelBinding = {
  harness: 'dsh', selector: 'profile', profile: 'headless-deepseek', verified: true,
  model: { id: 'deepseek-main', provider: 'deepseek', modelId: 'deepseek-v3' },
  reasoningEfforts: ['high'],
};
const zcodeBinding: ModelBinding = {
  harness: 'zcode', selector: 'isolated_config', configDir: 'C:/verified/zcode-config', mode: 'yolo', verified: true,
  model: { id: 'glm-main', provider: 'zai', modelId: 'glm-5' },
  reasoningEfforts: ['high'],
};

const context = (overrides: Partial<RunContext> = {}): RunContext => ({
  taskId: 'task-1', attemptId: 'attempt-1', role: 'implement', cwd: 'C:/repo with space',
  prompt: 'Fix the thing; keep spaces intact.', ...overrides,
});

test('Codex builds argv with an explicit model, workspace sandbox and reasoning effort', async () => {
  const adapter = new CodexAdapter();
  const invocation = await adapter.prepare(context({ reasoningEffort: 'high', outputSchemaPath: 'C:/artifacts/result schema.json' }), codexBinding);
  assert.equal(invocation.executable, 'codex');
  assert.deepEqual(invocation.args, [
    'exec', '--json', '--model', 'gpt-5-codex', '--sandbox', 'workspace-write', '--cd', 'C:/repo with space',
    '-c', 'model_reasoning_effort=high', '--output-schema', 'C:/artifacts/result schema.json', '-',
  ]);
  assert.equal(invocation.stdin, 'Fix the thing; keep spaces intact.');
  assert.equal(invocation.cwd, 'C:/repo with space');
});

test('Codex forces review to be read-only', async () => {
  const invocation = await new CodexAdapter().prepare(context({ role: 'review' }), codexBinding);
  assert.ok(invocation.args.includes('read-only'));
  assert.ok(!invocation.args.includes('workspace-write'));
  assert.ok(invocation.args.includes('--ignore-user-config'));
  assert.ok(invocation.args.includes('--ephemeral'));
});

test('Codex rejects an unverified reasoning level for the selected model binding', async () => {
  const binding = { ...codexBinding, reasoningEfforts: ['low'] as const } as ModelBinding;
  await assert.rejects(new CodexAdapter().prepare(context({ reasoningEffort: 'high' }), binding), /does not support reasoning effort/);
});

test('DSH uses only its verified profile and rejects unverified effort requests', async () => {
  const adapter = new DshAdapter();
  const invocation = await adapter.prepare(context(), dshBinding);
  assert.deepEqual(invocation.args, ['--profile', 'headless-deepseek', '--json', 'Fix the thing; keep spaces intact.']);
  assert.equal(invocation.requestedModel, 'deepseek-v3');
  await assert.rejects(adapter.prepare(context({ prompt: 'x'.repeat(20_000) }), dshBinding), /exceeds this Harness safe command-line budget/);
  await assert.rejects(adapter.prepare(context({ reasoningEffort: 'medium' }), dshBinding), /no verified reasoning effort/);
  await assert.rejects(adapter.prepare(context({ role: 'review' }), dshBinding), /implementation and revision/);
});

test('ZCode requires isolated model configuration and verified mode/effort', async () => {
  const adapter = new ZCodeAdapter();
  await assert.rejects(adapter.prepare(context(), zcodeBinding), /config directory does not exist/);
  await assert.rejects(adapter.prepare(context({ reasoningEffort: 'medium' }), zcodeBinding), /no verified reasoning effort/);
  await assert.rejects(adapter.prepare(context(), { ...zcodeBinding, selector: 'cli_argument' } as unknown as ModelBinding), /isolated_config/);
});

test('ZCode refuses prompts that exceed its safe argv budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero-zcode-config-'));
  try {
    const binding = { ...zcodeBinding, configDir: dir };
    await assert.rejects(new ZCodeAdapter().prepare(context({ prompt: 'x'.repeat(20_000) }), binding), /exceeds this Harness safe command-line budget/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('JSONL parser normalizes final text, actual model, session id, and malformed lines', () => {
  const parsed = parseJsonLines([
    JSON.stringify({ type: 'thread.started', thread_id: 'session-42' }),
    JSON.stringify({ type: 'item.completed', model: 'deepseek-v3', text: 'done' }),
    'not-json',
  ].join('\n'), 'warning');
  assert.equal(parsed.finalText, 'done');
  assert.equal(parsed.actualModel, 'deepseek-v3');
  assert.equal(parsed.sessionId, 'session-42');
  assert.deepEqual(parsed.events.map(({ type }) => type), ['thread.started', 'item.completed', 'unparsed', 'stderr']);
});

test('probe lists only verified per-harness model bindings', async () => {
  const adapter = new DshAdapter({ bindings: [dshBinding, codexBinding] });
  adapter.command = async (args) => args[0] === '--version'
    ? { code: 0, stdout: 'dsh 1.2.3', stderr: '' }
    : { code: 0, stdout: '--profile <name> --json', stderr: '' };
  const probe = await adapter.probe();
  assert.equal(probe.available, true);
  assert.deepEqual(probe.models, ['deepseek-main']);
  assert.deepEqual(probe.reasoningEfforts, ['high']);
});

test('probe fails closed when the CLI help does not advertise required options', async () => {
  const adapter = new CodexAdapter();
  adapter.command = async (args) => args[0] === '--version'
    ? { code: 0, stdout: 'codex 1.0', stderr: '' }
    : { code: 0, stdout: '--json --model', stderr: '' };
  const probe = await adapter.probe();
  assert.equal(probe.available, false);
  assert.deepEqual(probe.models, []);
  assert.match(probe.unavailableReason ?? '', /--sandbox, --cd, --output-schema, -c/);
});

test('missing configured model is rejected before invoking a process', async () => {
  const result = await new CodexAdapter().run({
    taskId: 't', attemptId: 'a', role: 'implement', cwd: 'C:/repo', prompt: 'x', harness: 'codex', model: 'unknown-model',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, null);
  assert.match(result.error ?? '', /No verified codex binding/);
});

test('run stores bounded, redacted logs and normalized events in artifactDir', async () => {
  class EchoAdapter extends BaseHarnessAdapter {
    readonly id = 'codex' as const;
    constructor(config: AdapterConfig) { super(config); }
    async probe() { return { harness: this.id, models: ['gpt-main'], available: true }; }
    async prepare(ctx: RunContext, binding: ModelBinding): Promise<Invocation> {
      return {
        harness: this.id, executable: process.execPath,
        args: ['-e', `console.log(JSON.stringify({type:'item.completed', text:${JSON.stringify(ctx.prompt)}}))`],
        cwd: ctx.cwd, env: {}, requestedModel: binding.model.modelId,
        parseOutput: (stdout, stderr) => parseJsonLines(stdout, stderr),
      };
    }
    protected parseOutput(stdout: string, stderr: string): ParsedOutput { return parseJsonLines(stdout, stderr); }
  }
  const artifactDir = await mkdtemp(join(tmpdir(), 'zero-adapter-'));
  try {
    const adapter = new EchoAdapter({ bindings: [codexBinding], maxLogBytes: 1024 });
    const result = await adapter.run({
      taskId: 'task-logs', attemptId: 'attempt-1', role: 'implement', cwd: process.cwd(), prompt: 'written output',
      harness: 'codex', model: 'gpt-main', artifactDir,
    });
    assert.equal(result.status, 'completed');
    assert.ok(result.stdoutPath && result.stderrPath && result.eventsPath);
    assert.match(await readFile(result.stdoutPath!, 'utf8'), /written output/);
    assert.match(await readFile(result.eventsPath!, 'utf8'), /item.completed/);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
