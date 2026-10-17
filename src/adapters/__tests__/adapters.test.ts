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

/** Runs only a deterministic local node child; no provider calls or configuration reads. */
class OutputFixtureAdapter extends BaseHarnessAdapter {
  readonly id: 'codex' | 'dsh' | 'zcode';
  constructor(private readonly script: string, private readonly parse: Invocation['parseOutput'] = parseJsonLines,
    config: AdapterConfig = {}, harness: 'codex' | 'dsh' | 'zcode' = 'codex') {
    super({ bindings: [harness === 'dsh' ? dshBinding : harness === 'zcode' ? zcodeBinding : codexBinding], ...config });
    this.id = harness;
  }
  async probe() { return { harness: this.id, available: true, models: this.bindings.map(binding => binding.model.id) }; }
  async prepare(ctx: RunContext): Promise<Invocation> {
    return { harness: this.id, executable: process.execPath, args: ['-e', this.script], cwd: ctx.cwd, env: {}, parseOutput: this.parse };
  }
  protected parseOutput(stdout: string, stderr: string): ParsedOutput { return this.parse(stdout, stderr); }
}
const fixtureRequest = () => ({ taskId: 'offline-output', attemptId: 'fixture-1', role: 'implement' as const,
  harness: 'codex' as const, model: 'gpt-main', cwd: process.cwd(), prompt: 'offline deterministic fixture' });

test('streaming protocol retains the actual final beyond the log cap and an oversized tool line', async () => {
  const script = `console.log(JSON.stringify({type:'thread.started',thread_id:'session-original',model:'gpt-5-codex'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'intermediate reasoning'}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'x'.repeat(3*1024*1024)}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'TRUE_LAST_AGENT_SUMMARY'}}));`;
  const result = await new OutputFixtureAdapter(script).run(fixtureRequest());
  assert.equal(result.status, 'completed');
  assert.equal(result.final, 'TRUE_LAST_AGENT_SUMMARY');
  assert.equal(result.sessionId, 'session-original');
  assert.equal(result.actualModel, 'gpt-5-codex');
});

test('only agent completion can replace a typed agent final; reasoning and tool text cannot', () => {
  const parsed = parseJsonLines([
    { type: 'item.completed', item: { type: 'agent_message', text: 'actual final' } },
    { type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', text: 'tool output' } },
  ].map(value => JSON.stringify(value)).join('\n'));
  assert.equal(parsed.finalText, 'actual final');
});

test('streamed final decodes split UTF-8 and redacts secrets spanning process chunks and beyond log truncation', async () => {
  const secret = 'fixture-secret-跨界';
  const script = `console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'x'.repeat(3*1024*1024)}}));
    const b=Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'接力完成 😀 fixture-secret-跨界 下一步验证'}})+'\\n');
    const split=b.indexOf(Buffer.from('😀'))+1;process.stdout.write(b.subarray(0,split));
    setTimeout(()=>{const split2=b.indexOf(Buffer.from('secret'))+3;process.stdout.write(b.subarray(split,split2));
      setTimeout(()=>process.stdout.write(b.subarray(split2)),10);},10);`;
  const result = await new OutputFixtureAdapter(script, parseJsonLines, {
    maxLogBytes: 1024, secretRefs: { FIXTURE_TOKEN: 'fixture-secret' }, resolveSecret: () => secret,
  }).run(fixtureRequest());
  assert.equal(result.status, 'completed');
  assert.equal(result.final, '接力完成 😀 [REDACTED] 下一步验证');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('structured agent and tool quotes never classify an unrelated failure as provider quota', async () => {
  for (const script of [
    `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Implemented: usage limit reached'}}));console.error('Permission denied');process.exitCode=1;`,
    `console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',text:'quota exceeded'}}));console.error("You've hit your usage limit");process.exitCode=1;`,
    `console.log(JSON.stringify({type:'error',message:'invalid API key'}));console.error('tool stderr: usage limit reached');process.exitCode=1;`,
  ]) {
    const result = await new OutputFixtureAdapter(script).run(fixtureRequest());
    assert.equal(result.status, 'failed');
    assert.equal(result.quota, undefined);
  }
});

test('provider error events past truncated tool output retain quota while plain provider stderr stays supported', async () => {
  const scripts = [
    `console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'x'.repeat(3*1024*1024)}}));console.log(JSON.stringify({type:'turn.failed',error:{message:"You've hit your usage limit. Retry-After: 60"}}));process.exitCode=1;`,
    `console.error("Error: You've hit your usage limit. Retry-After: 60");process.exitCode=1;`,
  ];
  for (const script of scripts) {
    const result = await new OutputFixtureAdapter(script, parseJsonLines, { maxLogBytes: 1024 }).run(fixtureRequest());
    assert.equal(result.status, 'failed');
    assert.equal(result.quota?.source, 'retry_after');
  }
  const quoted = await new OutputFixtureAdapter(`console.error('tool stderr: usage limit reached');process.exitCode=1;`).run(fixtureRequest());
  assert.equal(quoted.quota, undefined);
});

test('a later matching model cannot erase an earlier mismatched model identity', async () => {
  const result = await new OutputFixtureAdapter(`console.log(JSON.stringify({type:'thread.started',model:'different-model'}));
    console.log(JSON.stringify({type:'turn.completed',model:'gpt-5-codex'}));`).run(fixtureRequest());
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /model/i);
});

test('streaming cannot erase a model mismatch observed in a complete oversized diagnostic event', async () => {
  for (const prefix of ['', `console.log(JSON.stringify({type:'thread.started',model:'gpt-5-codex'}));`]) {
    const result = await new OutputFixtureAdapter(`${prefix}
      console.log(JSON.stringify({type:'thread.started',model:'different-model',thread_id:'oversized-session',metadata:'x'.repeat(270000)}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'actual final'}}));`).run(fixtureRequest());
    assert.equal(result.status, 'failed', 'a later final cannot conceal an observed mismatch');
    assert.match(result.error ?? '', /model/i);
    assert.equal(result.final, 'actual final');
    assert.equal(result.sessionId, 'oversized-session');
    assert.equal(result.metadata?.modelVerification, 'event_confirmed');
  }
});

test('model identities after oversized tool values remain observable beyond the entire diagnostic cap', async () => {
  for (const event of [
    `{type:'thread.started',model:'different-model',metadata:'x'.repeat(3*1024*1024)}`,
    `{type:'item.completed',item:{type:'command_execution',aggregated_output:'x'.repeat(3*1024*1024)},model:'different-model'}`,
  ]) {
    const result = await new OutputFixtureAdapter(`console.log(JSON.stringify(${event}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'actual final'}}));`).run(fixtureRequest());
    assert.equal(result.status, 'failed');
    assert.equal(result.actualModel, 'different-model');
    assert.match(result.error ?? '', /model/i);
  }
});

test('structured billing error codes remain ordinary failures instead of entering quota wait', async () => {
  for (const event of [
    { type: 'turn.failed', error: { code: 'insufficient_quota', message: 'Quota exceeded' } },
    { type: 'error', code: 'billing_hard_limit_reached', message: 'Quota exceeded' },
    { type: 'response.failed', error: { type: 'credit_balance_exhausted', message: 'Usage limit reached' } },
  ]) {
    const result = await new OutputFixtureAdapter(`console.log(${JSON.stringify(JSON.stringify(event))});process.exitCode=1;`).run(fixtureRequest());
    assert.equal(result.status, 'failed');
    assert.equal(result.quota, undefined, 'account action cannot be resolved by quota sleep/retry');
  }
});

test('the latest structured authentication failure supersedes an earlier quota retry message', async () => {
  const result = await new OutputFixtureAdapter(`console.log(JSON.stringify({type:'error',message:'Quota exceeded; Retry-After: 60'}));
    console.log(JSON.stringify({type:'turn.failed',error:{code:'invalid_api_key',message:'Authentication failed'}}));process.exitCode=1;`).run(fixtureRequest());
  assert.equal(result.status, 'failed');
  assert.equal(result.quota, undefined);
  assert.match(result.error ?? '', /invalid_api_key|Authentication failed/);
});

test('the current billing error survives a full error history and truncated diagnostic logs', async () => {
  const result = await new OutputFixtureAdapter(`for(let i=0;i<16;i++)console.log(JSON.stringify({type:'error',message:i===0?'Quota exceeded; Retry-After: 60':'Transient network error'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',text:'x'.repeat(3*1024*1024)}}));
    console.log(JSON.stringify({type:'turn.failed',error:{code:'insufficient_quota',message:'Quota exceeded'}}));process.exitCode=1;`).run(fixtureRequest());
  assert.equal(result.status, 'failed');
  assert.equal(result.quota, undefined);
  assert.match(result.error ?? '', /insufficient_quota/);
});

test('a current provider quota after a full history retains recovery and its actual diagnostic', async () => {
  const result = await new OutputFixtureAdapter(`for(let i=0;i<16;i++)console.log(JSON.stringify({type:'error',message:'Transient network error'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',text:'x'.repeat(3*1024*1024)}}));
    console.log(JSON.stringify({type:'turn.failed',error:{message:'Quota exceeded; Retry-After: 60'}}));process.exitCode=1;`).run(fixtureRequest());
  assert.equal(result.status, 'failed');
  assert.equal(result.quota?.source, 'retry_after');
  assert.match(result.error ?? '', /Quota exceeded/);
});

test('unverifiable oversized provider metadata cannot trigger automatic quota recovery', async () => {
  const result = await new OutputFixtureAdapter(`console.log(JSON.stringify({type:'turn.failed',metadata:'x'.repeat(270000),
    error:{code:'x'.repeat(5000),message:'Quota exceeded'}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'untrusted final'}}));process.exitCode=1;`).run(fixtureRequest());
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /metadata|protocol/i);
  assert.equal(result.quota, undefined, 'incomplete provider evidence must not authorize a retry checkpoint');
});

test('an earlier recoverable provider error cannot hide a later oversized final', async () => {
  const result = await new OutputFixtureAdapter(`console.log(JSON.stringify({type:'error',message:'Transient connection failed; reconnecting'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'x'.repeat(3*1024*1024)}}));`).run(fixtureRequest());
  assert.equal(result.status, 'failed');
  assert.equal(result.final, undefined);
  assert.match(result.error ?? '', /output|final|limit/i);
  assert.equal(result.quota, undefined);
});

test('a quota message before an unreadable later final does not authorize automatic recovery', async () => {
  const result = await new OutputFixtureAdapter(`console.log(JSON.stringify({type:'error',message:'Quota exceeded; Retry-After: 60'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'x'.repeat(3*1024*1024)}}));process.exitCode=1;`).run(fixtureRequest());
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /output|final|limit/i);
  assert.equal(result.quota, undefined);
});

test('oversized final fails explicitly instead of relaying an earlier reasoning message', async () => {
  const result = await new OutputFixtureAdapter(`console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'stale thought'}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'x'.repeat(3*1024*1024)}}));`).run(fixtureRequest());
  assert.equal(result.status, 'failed');
  assert.equal(result.final, undefined);
  assert.match(result.error ?? '', /output|line|final|limit/i);
});

test('streaming preserves the official ZCode response final and DSH multiline plaintext final', async () => {
  const zcode = new ZCodeAdapter();
  const zcodeParser = (stdout: string, stderr: string) => Reflect.get(zcode, 'parseOutput').call(zcode, stdout, stderr) as ParsedOutput;
  const zcodeResult = await new OutputFixtureAdapter(`console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'x'.repeat(3*1024*1024)}}));
    console.log(JSON.stringify({type:'result',response:'ZCODE_OFFICIAL_FINAL',sessionId:'zcode-session'}));`, zcodeParser, {}, 'zcode')
    .run({ ...fixtureRequest(), harness: 'zcode', model: 'glm-main' });
  assert.equal(zcodeResult.final, 'ZCODE_OFFICIAL_FINAL');
  assert.equal(zcodeResult.sessionId, 'zcode-session');
  const plain = (stdout: string, stderr: string) => ({ finalText: stdout.trim(), events: [{ type: 'output', message: stdout }, { type: 'stderr', message: stderr }] });
  const dshResult = await new OutputFixtureAdapter(`process.stdout.write('Implementation complete\\nNext agent: check edge cases\\n');`, plain, {}, 'dsh')
    .run({ ...fixtureRequest(), harness: 'dsh', model: 'deepseek-main' });
  assert.equal(dshResult.final, 'Implementation complete\nNext agent: check edge cases');
});

test('Codex builds argv with an explicit model, workspace sandbox and reasoning effort', async () => {
  const adapter = new CodexAdapter();
  const invocation = await adapter.prepare(context({ reasoningEffort: 'high', outputSchemaPath: 'C:/artifacts/result schema.json' }), codexBinding);
  assert.equal(invocation.executable, 'codex');
  assert.deepEqual(invocation.args, [
    'exec', '--json', '--model', 'gpt-5-codex', '--sandbox', 'workspace-write', '--cd', 'C:/repo with space',
    '-c', 'approval_policy=never',
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

test('Codex disables interactive approval for every role and preserves role-specific config behavior', async () => {
  const adapter = new CodexAdapter();
  for (const role of ['implement', 'revise', 'review', 'allocate'] as const) {
    const invocation = await adapter.prepare(context({ role }), codexBinding);
    const approvalOverride = invocation.args.indexOf('approval_policy=never');
    assert.ok(approvalOverride > 0, `${role} should set approval_policy=never`);
    assert.equal(invocation.args[approvalOverride - 1], '-c');
    const readOnly = role === 'review' || role === 'allocate';
    assert.ok(invocation.args.includes(readOnly ? 'read-only' : 'workspace-write'));
    assert.equal(invocation.args.includes('--ignore-user-config'), readOnly);
    assert.equal(invocation.args.includes('--ephemeral'), readOnly);
  }
});

test('Codex applies an explicit Windows sandbox override to every role when configured', async () => {
  for (const mode of ['elevated', 'unelevated'] as const) {
    const adapter = new CodexAdapter({ codexWindowsSandbox: mode });
    for (const role of ['implement', 'revise', 'review', 'allocate'] as const) {
      const invocation = await adapter.prepare(context({ role }), codexBinding);
      const overrideIndex = invocation.args.indexOf(`windows.sandbox=${mode}`);
      assert.ok(overrideIndex > 0, `${role} should set windows.sandbox=${mode}`);
      assert.equal(invocation.args[overrideIndex - 1], '-c');
    }
  }
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
    const trace = await readFile(join(artifactDir, 'task-logs-attempt-1.lifecycle.jsonl'), 'utf8');
    assert.match(trace, /"eventType":"item.completed"/);
    assert.doesNotMatch(trace, /written output/);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
