import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../codex.js';
import { DshAdapter, parseEffectiveModel } from '../dsh.js';
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

test('DSH uses the positional headless task interface and plain final output', async () => {
  const adapter = new DshAdapter({ dshHome: 'C:/zero/dsh-home' });
  adapter.command = async args => args[0] === '--version'
    ? { code: 0, stdout: '0.1.5-rc.2', stderr: '' }
    : { code: 0, stdout: '- id: agent-default-model\n  config:\n    provider: deepseek\n    model: deepseek-v3', stderr: '' };
  const invocation = await adapter.prepare(context(), dshBinding);
  assert.deepEqual(invocation.args, ['--profile', 'headless-deepseek', 'Fix the thing; keep spaces intact.']);
  assert.equal(invocation.env.DSH_HOME, 'C:/zero/dsh-home');
  assert.equal(invocation.requestedModel, 'deepseek-v3');
  assert.deepEqual(invocation.parseOutput('final answer\n', 'reasoning trace'), {
    events: [
      { type: 'output', message: 'final answer' },
      { type: 'stderr', message: 'reasoning trace' },
    ],
    finalText: 'final answer',
  });
  await assert.rejects(adapter.prepare(context({ prompt: 'x'.repeat(20_000) }), dshBinding), /exceeds this Harness safe command-line budget/);
  await assert.rejects(adapter.prepare(context({ reasoningEffort: 'high' }), dshBinding), /no verified per-run reasoning-effort selector/);
  await assert.rejects(adapter.prepare(context({ role: 'review' }), dshBinding), /implementation and revision/);
  assert.deepEqual((await adapter.prepare(context(), { ...dshBinding, profile: 'headless-alt' })).args.slice(0, 2), ['--profile', 'headless-alt']);
  await assert.rejects(adapter.prepare(context(), { ...dshBinding, profile: '../default' }), /safe profile name/);
  await assert.rejects(adapter.prepare(context(), { ...dshBinding, profile: 'nested/profile' }), /safe profile name/);
  await assert.rejects(adapter.prepare(context(), { ...dshBinding, profile: 'desktop' }), /safe profile name/);
  await assert.rejects(adapter.prepare(context(), { ...dshBinding, profile: 'Desktop' }), /safe profile name/);
  await assert.rejects(new DshAdapter().prepare(context(), dshBinding), /DSH_HOME/);
});

test('DSH honors ZERO_DSH_EXE for direct native executable paths', async () => {
  const previous = process.env.ZERO_DSH_EXE;
  process.env.ZERO_DSH_EXE = 'C:/zero-tools/dsh.exe';
  try {
    const adapter = new DshAdapter({ dshHome: 'C:/zero/dsh-home' });
    adapter.command = async args => args[0] === '--version'
      ? { code: 0, stdout: '0.1.5-rc.2', stderr: '' }
      : { code: 0, stdout: '- id: agent-default-model\n  config:\n    provider: deepseek\n    model: deepseek-v3', stderr: '' };
    const invocation = await adapter.prepare(context(), dshBinding);
    assert.equal(invocation.executable, 'C:/zero-tools/dsh.exe');
    assert.deepEqual(invocation.args.slice(0, 2), ['--profile', 'headless-deepseek']);
  } finally {
    if (previous === undefined) delete process.env.ZERO_DSH_EXE;
    else process.env.ZERO_DSH_EXE = previous;
  }
});

test('DSH launches ZERO_DSH_ENTRY through Node for probes and task argv', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'zero-dsh-entry-'));
  const dshHome = join(tempDir, 'dsh-home');
  const entry = join(tempDir, 'fake-dsh.mjs');
  await mkdir(dshHome, { recursive: true });
  await writeFile(entry, [
    `if (process.env.DSH_HOME !== ${JSON.stringify(dshHome)}) process.exit(12);`,
    'const args = process.argv.slice(2);',
    "if (args[0] === '--version') console.log('0.1.5-rc.2');",
    "else if (args.join(' ') === '--profile headless --help') console.log('Usage: dsh --profile headless [options] [task...]');",
    "else if (args[0] === '--profile' && args[2] === '--dump-config') console.log('- id: agent-default-model\\n  config:\\n    provider: deepseek\\n    model: deepseek-v3');",
    "else console.log('unexpected args');",
  ].join('\n'));
  const previousEntry = process.env.ZERO_DSH_ENTRY;
  const previousExe = process.env.ZERO_DSH_EXE;
  delete process.env.ZERO_DSH_EXE;
  process.env.ZERO_DSH_ENTRY = entry;
  try {
    const adapter = new DshAdapter({ dshHome });
    const probe = await adapter.probe();
    assert.equal(probe.available, true);
    assert.equal(probe.version, '0.1.5-rc.2');
    assert.deepEqual(probe.models, []);
    const invocation = await adapter.prepare(context(), dshBinding);
    assert.equal(invocation.executable, process.execPath);
    assert.deepEqual(invocation.args, [entry, '--profile', 'headless-deepseek', 'Fix the thing; keep spaces intact.']);
    assert.equal(invocation.env.DSH_HOME, dshHome);
  } finally {
    if (previousEntry === undefined) delete process.env.ZERO_DSH_ENTRY;
    else process.env.ZERO_DSH_ENTRY = previousEntry;
    if (previousExe === undefined) delete process.env.ZERO_DSH_EXE;
    else process.env.ZERO_DSH_EXE = previousExe;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('DSH rejects Windows command shims with a clear shell-free launch error', async () => {
  const adapter = new DshAdapter({ dshHome: 'C:/zero/dsh-home', executable: 'C:/tools/dsh.cmd' });
  const probe = await adapter.probe();
  assert.equal(probe.available, false);
  assert.match(probe.unavailableReason ?? '', /\.cmd\/.bat launchers cannot run with shell:false/);
  await assert.rejects(adapter.prepare(context(), dshBinding), /\.cmd\/.bat launchers cannot run with shell:false/);
});

test('DSH probe only exposes version-matched bindings whose effective profile model matches', async () => {
  const seen: string[][] = [];
  const adapter = new DshAdapter({ dshHome: 'C:/zero/dsh-home', bindings: [dshBinding, codexBinding] });
  adapter.command = async (args) => {
    seen.push(args);
    if (args[0] === '--version') return { code: 0, stdout: '0.1.5-rc.2', stderr: '' };
    if (args[2] === '--dump-config') return { code: 0, stdout: '- id: agent-default-model\n  config:\n    provider: deepseek\n    model: deepseek-v3', stderr: '' };
    return { code: 0, stdout: 'Usage: dsh --profile headless [options] [task...]', stderr: '' };
  };
  const probe = await adapter.probe();
  assert.deepEqual(seen, [['--version'], ['--profile', 'headless', '--help'], ['--version'], ['--profile', 'headless-deepseek', '--dump-config']]);
  assert.equal(probe.available, true);
  assert.equal(probe.version, '0.1.5-rc.2');
  assert.deepEqual(probe.models, ['deepseek-main']);
  assert.deepEqual(probe.reasoningEfforts, []);
  assert.equal(probe.probeEvidence?.configuredBindings, 'declared_verified');
  assert.deepEqual(probe.probeEvidence?.bindingVerification, { 'deepseek-main': 'manual_config' });
});

test('DSH run refuses a profile whose effective model does not match before starting a task process', async () => {
  const seen: string[][] = [];
  const adapter = new DshAdapter({ dshHome: 'C:/zero/dsh-home', bindings: [dshBinding] });
  adapter.command = async (args) => {
    seen.push(args);
    if (args[0] === '--version') return { code: 0, stdout: '0.1.5-rc.2', stderr: '' };
    if (args[2] === '--dump-config') return { code: 0, stdout: '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash', stderr: '' };
    return { code: 0, stdout: 'Usage: dsh --profile headless [options] [task...]', stderr: '' };
  };
  const result = await adapter.run({
    taskId: 'task-dsh', attemptId: 'attempt-1', role: 'implement', cwd: process.cwd(), prompt: 'no model request',
    harness: 'dsh', model: 'deepseek-main',
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /not verified for the installed dsh CLI version/);
  assert.ok(seen.some(args => args[2] === '--dump-config'));
});

test('DSH effective model parser applies later profile layers and rejects missing target config', () => {
  assert.deepEqual(parseEffectiveModel(`# == base\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n# == profile\n- id: agent-default-model\n  config:\n    provider: deepseek\n    model: deepseek-v3`), { provider: 'deepseek', modelId: 'deepseek-v3' });
  assert.equal(parseEffectiveModel('- id: unrelated\n  config:\n    provider: deepseek\n    model: deepseek-v3'), undefined);
});

test('ZCode requires an isolated profile selecting the exact provider/model', async () => {
  const adapter = new ZCodeAdapter();
  await assert.rejects(adapter.prepare(context(), zcodeBinding), /must contain .zcode\/cli\/config.json selecting zai\/glm-5/);
  await assert.rejects(adapter.prepare(context(), { ...zcodeBinding, configDir: 'relative-profile' }), /must contain .zcode\/cli\/config.json selecting zai\/glm-5/);
  await assert.rejects(adapter.prepare(context(), { ...zcodeBinding, selector: 'cli_argument' } as unknown as ModelBinding), /isolated_config/);
  await assert.rejects(adapter.prepare(context(), { ...zcodeBinding, mode: '' }), /permission mode/);
});

test('ZCode uses documented data root and a profile with an exact selected model', async () => {
  const dataBaseDir = await mkdtemp(join(tmpdir(), 'zero-zcode-config-'));
  const cliConfigDir = join(dataBaseDir, '.zcode', 'cli');
  await mkdir(cliConfigDir, { recursive: true });
  await writeFile(join(cliConfigDir, 'config.json'), JSON.stringify({ model: { main: 'zai/glm-5' } }));
  try {
    const invocation = await new ZCodeAdapter().prepare(context(), { ...zcodeBinding, configDir: dataBaseDir });
    assert.deepEqual(invocation.args, [
      '--prompt', 'Fix the thing; keep spaces intact.', '--cwd', 'C:/repo with space', '--mode', 'yolo', '--output-format', 'stream-json',
    ]);
    assert.equal(invocation.env.ZCODE_DATA_BASE_DIR, dataBaseDir);
    assert.equal(invocation.env.APPDATA, undefined);
    assert.equal(invocation.requestedModel, 'glm-5');
    const result = invocation.parseOutput(JSON.stringify({ type: 'result', sessionId: 'sess-42', response: 'ZERO_ZCODE_NONCE' }), '');
    assert.equal(result.finalText, 'ZERO_ZCODE_NONCE');
    assert.equal(result.sessionId, 'sess-42');
    assert.equal(result.actualModel, undefined);
  } finally { await rm(dataBaseDir, { recursive: true, force: true }); }
});

test('ZCode starts an absolute JavaScript entry through Node without a shell', async () => {
  const dataBaseDir = await mkdtemp(join(tmpdir(), 'zero-zcode-config-'));
  const cliConfigDir = join(dataBaseDir, '.zcode', 'cli');
  await mkdir(cliConfigDir, { recursive: true });
  await writeFile(join(cliConfigDir, 'config.json'), JSON.stringify({ model: { main: 'zai/glm-5' } }));
  const entry = join(dataBaseDir, 'zcode.cjs');
  try {
    const invocation = await new ZCodeAdapter({ zcodeEntry: entry }).prepare(context(), { ...zcodeBinding, configDir: dataBaseDir });
    assert.equal(invocation.executable, process.execPath);
    assert.equal(invocation.args[0], entry);
    assert.equal(invocation.args[1], '--prompt');
  } finally { await rm(dataBaseDir, { recursive: true, force: true }); }
});

test('ZCode rejects a manual reasoning effort even when the binding claims to support it', async () => {
  const dataBaseDir = await mkdtemp(join(tmpdir(), 'zero-zcode-config-'));
  await mkdir(join(dataBaseDir, '.zcode', 'cli'), { recursive: true });
  await writeFile(join(dataBaseDir, '.zcode', 'cli', 'config.json'), JSON.stringify({ model: { main: 'zai/glm-5' } }));
  try {
    const binding = { ...zcodeBinding, configDir: dataBaseDir, reasoningEfforts: ['high'] } as ModelBinding;
    await assert.rejects(new ZCodeAdapter().prepare(context({ reasoningEffort: 'high' }), binding), /cannot enforce the requested reasoning effort high/);
    await assert.rejects(new ZCodeAdapter().prepare(context(), binding), /no verified effort selector/);
  } finally { await rm(dataBaseDir, { recursive: true, force: true }); }
});

test('ZCode refuses a profile whose model differs from the binding', async () => {
  const dataBaseDir = await mkdtemp(join(tmpdir(), 'zero-zcode-config-'));
  await mkdir(join(dataBaseDir, '.zcode', 'cli'), { recursive: true });
  await writeFile(join(dataBaseDir, '.zcode', 'cli', 'config.json'), JSON.stringify({ model: { main: 'zai/glm-5.3' } }));
  try {
    await assert.rejects(new ZCodeAdapter().prepare(context(), { ...zcodeBinding, configDir: dataBaseDir }), /selecting zai\/glm-5/);
  } finally { await rm(dataBaseDir, { recursive: true, force: true }); }
});

test('ZCode refuses prompts that exceed its safe argv budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero-zcode-config-'));
  await mkdir(join(dir, '.zcode', 'cli'), { recursive: true });
  await writeFile(join(dir, '.zcode', 'cli', 'config.json'), JSON.stringify({ model: { main: 'zai/glm-5' } }));
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
