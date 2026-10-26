import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BossMessage, HarnessAdapter, HarnessCapabilities, RunRequest, RunResult, TaskRecord } from '../domain/types.js';
import { BossOrchestrator, type BossPlanContext } from './boss.js';
import type { RouteCandidate } from './router.js';
import { QuotaLimitError } from '../core/quota.js';

const exec = promisify(execFile);
class Adapter implements HarnessAdapter {
  constructor(readonly id: string, readonly models: string[], readonly efforts: string[] = []) {}
  async probe(): Promise<HarnessCapabilities> { return { harness: this.id, available: true, models: this.models, reasoningEfforts: this.efforts }; }
  async run(): Promise<RunResult> { throw new Error('Boss must delegate calls to its durable worker context'); }
}
const candidates: RouteCandidate[] = [
  { bindingId: 'codex:boss', harness: 'codex', model: 'gpt-6.1-sol', verified: true, available: true, healthy: true, reasoningEfforts: ['low', 'high'], capabilities: ['code'] },
  { bindingId: 'codex:cheap', harness: 'codex', model: 'cheap', verified: true, available: true, healthy: true, reasoningEfforts: ['low'], capabilities: ['code'] },
  { bindingId: 'dsh:deepseek', harness: 'dsh', model: 'deepseek', verified: true, available: true, healthy: true, reasoningEfforts: [], capabilities: ['code'] },
  { bindingId: 'zcode:glm', harness: 'zcode', model: 'glm', verified: true, available: true, healthy: true, reasoningEfforts: [], capabilities: ['code'] },
  { bindingId: 'codex:unverified', harness: 'codex', model: 'unverified', verified: false, available: true, healthy: true, reasoningEfforts: ['high'], capabilities: ['code'] },
];
function selection(overrides: Record<string, unknown> = {}): string { return JSON.stringify({ bindingId: 'codex:boss', reasoningEffort: 'high', reason: 'Resolve the user preference to the verified Codex boss.', ...overrides }); }
function plan(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ action: 'plan', summary: 'Build and verify the requested tool.', consultantBindingId: null, consultantEffort: null, question: null,
    acceptanceCriteria: ['The requested behavior is covered by a regression test.'],
    stages: [{ bindingId: 'dsh:deepseek', reasoningEffort: null, objective: 'Implement the tool and its tests.' }, { bindingId: 'codex:cheap', reasoningEffort: 'low', objective: 'Inspect integration and finish outstanding implementation.' }],
    checks: [{ id: 'tests', argv: ['node', '--test', 'tool.test.mjs'] }], maxRevisions: 3, ...overrides });
}
function consult(bindingId = 'dsh:deepseek', reasoningEffort: string | null = null): string {
  return JSON.stringify({ action: 'consult', summary: 'Discuss the experimental design before assigning implementation.', consultantBindingId: bindingId, consultantEffort: reasoningEffort,
    question: 'Which experiments distinguish a correct implementation from plausible output?', acceptanceCriteria: [], stages: [], checks: [], maxRevisions: 0 });
}
async function fixture(run: (request: Omit<RunRequest, 'taskId' | 'attemptId'>, purpose: string, adapter: HarnessAdapter) => Promise<RunResult>, source = candidates, artifactDirectory = 'artifacts') {
  const root = await mkdtemp(join(tmpdir(), 'zero-boss-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  await writeFile(join(workspace, 'tool.mjs'), 'export const ready = true;\n');
  await writeFile(join(workspace, 'AGENTS.md'), 'UNTRUSTED PROJECT INSTRUCTIONS');
  await exec('git', ['init', '--quiet', '--initial-branch=main'], { cwd: workspace, windowsHide: true });
  await exec('git', ['add', '-A'], { cwd: workspace, windowsHide: true });
  await exec('git', ['-c', 'user.name=Zero Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'fixture'], { cwd: workspace, windowsHide: true });
  const codex = new Adapter('codex', ['gpt-6.1-sol', 'cheap', 'unverified'], ['low', 'high']);
  const adapters = new Map<string, HarnessAdapter>([['codex', codex], ['dsh', new Adapter('dsh', ['deepseek'])], ['zcode', new Adapter('zcode', ['glm'])]]);
  const messages: Array<Omit<BossMessage, 'id' | 'at'>> = [];
  const task: TaskRecord = { id: 'boss-task', repoPath: workspace, baseRef: 'HEAD', prompt: 'Build a working command line tool.', boss: { preference: 'codex gpt6.1sol high' }, acceptanceCriteria: ['Preserve the public interface.'], status: 'running', revisionCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const context: BossPlanContext = { cwd: workspace, messages: [{ id: 'm1', role: 'user', content: 'Include runnable tests.', at: new Date().toISOString() }],
    run: (adapter, request, purpose) => run(request, purpose, adapter), onMessage: message => { messages.push(message); } };
  const boss = new BossOrchestrator({ codex, adapters, getCandidates: async () => source, artifactRoot: join(root, artifactDirectory) });
  return { root, workspace, boss, task, context, messages, dispose: () => rm(root, { recursive: true, force: true }) };
}
const result = (final: string): RunResult => ({ status: 'completed', exitCode: 0, durationMs: 1, final });

test('Boss resolves a natural preference, consults a different harness in a disposable snapshot, and delegates affordable stages', async () => {
  const calls: Array<{ purpose: string; request: Omit<RunRequest, 'taskId' | 'attemptId'> }> = [];
  const f = await fixture(async (request, purpose, adapter) => {
    calls.push({ purpose, request });
    assert.notEqual(resolve(request.cwd), resolve(f.workspace));
    await assert.rejects(access(join(request.cwd, 'AGENTS.md')));
    if (purpose === 'boss_selection') { assert.match(request.prompt, /codex gpt6\.1sol high/); assert.ok(!request.prompt.includes('codex:unverified')); return result(selection()); }
    if (purpose === 'boss_consult') {
      assert.equal(adapter.id, 'dsh'); assert.equal(request.role, 'implement'); assert.equal(request.readOnly, undefined);
      assert.match(request.prompt, /disposable|隔离/i);
      await writeFile(join(request.cwd, 'consultant-created.txt'), 'must never reach the project');
      return result('CONSULTANT EVIDENCE: test boundary cases before implementation.');
    }
    assert.equal(adapter.id, 'codex'); assert.equal(request.role, 'route'); assert.equal(request.readOnly, true);
    assert.match(request.prompt, /Include runnable tests/);
    if (calls.length === 2) return result(consult());
    assert.match(request.prompt, /CONSULTANT EVIDENCE/);
    return result(plan());
  });
  try {
    const planned = await f.boss.plan(f.task, f.context);
    assert.deepEqual(planned.boss, { harness: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' });
    assert.equal(planned.stages[0]!.harness, 'dsh'); assert.equal(planned.stages[1]!.model, 'cheap');
    assert.ok(planned.acceptanceCriteria.includes('Preserve the public interface.'));
    assert.equal(planned.checks[0]!.argv[0], 'node');
    assert.deepEqual(calls.map(call => call.purpose), ['boss_selection', 'boss_plan', 'boss_consult', 'boss_plan']);
    assert.ok(f.messages.some(message => message.role === 'consultant' && message.harness === 'dsh'));
    await assert.rejects(access(join(f.workspace, 'consultant-created.txt')));
    for (const call of calls) await assert.rejects(access(call.request.cwd));
    assert.ok(!JSON.stringify(planned).includes('.zero-codex-'));
  } finally { await f.dispose(); }
});

test('Boss consults Codex with route/read-only and ZCode with isolated implement permissions', async () => {
  let step = 0;
  const f = await fixture(async (request, purpose, adapter) => {
    if (purpose === 'boss_selection') return result(selection());
    if (purpose === 'boss_consult') {
      assert.equal(request.role, adapter.id === 'codex' ? 'route' : 'implement');
      assert.equal(request.readOnly, adapter.id === 'codex' ? true : undefined);
      return result(`${adapter.id} independent design advice`);
    }
    return result(step++ === 0 ? consult('codex:cheap', 'low') : step === 2 ? consult('zcode:glm') : plan());
  });
  try { assert.equal((await f.boss.plan(f.task, f.context)).stages.length, 2); assert.equal(f.messages.filter(message => message.role === 'consultant').length, 2); }
  finally { await f.dispose(); }
});

test('long consultant advice is fully retained and reaches the lead without exceeding durable message bounds', async () => {
  let decisions = 0;
  const advice = `${'A'.repeat(16000)}LAST_REQUIRED_EXPERIMENT`;
  const f = await fixture(async (request, purpose) => {
    if (purpose === 'boss_selection') return result(selection());
    if (purpose === 'boss_consult') return result(advice);
    if (decisions++ === 0) return result(consult());
    assert.ok(request.prompt.includes(advice));
    return result(plan());
  });
  const original = f.context.onMessage;
  f.context.onMessage = message => { assert.ok(message.content.length <= 16000); original(message); };
  try {
    await f.boss.plan(f.task, f.context);
    const retained = f.messages.filter(message => message.role === 'consultant').map(message => message.content).join('');
    assert.ok(retained.endsWith(advice));
  } finally { await f.dispose(); }
});

test('adaptive plans respect the total stage budget including the frozen completed prefix', async () => {
  let remaining = 2;
  const f = await fixture(async (request, purpose) => {
    if (purpose === 'boss_selection') return result(selection());
    assert.match(request.prompt, /1 to 1 concrete remaining stages/);
    return result(plan({ stages: Array.from({ length: remaining }, () => ({ bindingId: 'dsh:deepseek', reasoningEffort: null, objective: 'Finish remaining work' })) }));
  });
  try {
    f.context.completedStages = 15;
    await assert.rejects(f.boss.plan(f.task, f.context), /remaining stage budget/);
    remaining = 1;
    assert.equal((await f.boss.plan(f.task, f.context)).stages.length, 1);
    f.context.completedStages = 16;
    await assert.rejects(f.boss.plan(f.task, f.context), /no remaining stage budget/);
  } finally { await f.dispose(); }
});

test('Boss validates plans, model identities, supported efforts, nonempty meaningful checks, and strict JSON fields', async () => {
  const invalid = [
    plan({ stages: [] }), plan({ stages: [{ bindingId: 'codex:unverified', reasoningEffort: 'high', objective: 'Code it' }] }),
    plan({ stages: [{ bindingId: 'dsh:deepseek', reasoningEffort: 'high', objective: 'Code it' }] }),
    plan({ checks: [] }), plan({ checks: [{ id: 'fake', argv: ['echo', 'passed'] }] }),
    plan({ checks: [{ id: 'fake', argv: ['node', '-e', 'process.exit(0)'] }] }),
    plan({ maxRevisions: 11 }), plan({ acceptanceCriteria: [] }), plan({ unexpected: 'silently ignored' }),
    consult('nonexistent'), consult('dsh:deepseek', 'high'),
  ];
  const f = await fixture(async (_request, purpose) => result(purpose === 'boss_selection' ? selection() : invalid.shift()!));
  try { while (invalid.length) await assert.rejects(f.boss.plan(f.task, f.context), /Boss|binding|effort|check|plan/i); }
  finally { await f.dispose(); }
});

test('Boss does not silently use unavailable preferred model and rejects invalid selector resolutions', async () => {
  const f = await fixture(async (_request, purpose) => result(purpose === 'boss_selection' ? selection({ bindingId: 'codex:unverified' }) : plan()));
  try { await assert.rejects(f.boss.plan(f.task, f.context), /binding|verified/i); }
  finally { await f.dispose(); }
  const unavailable = await fixture(async () => { throw new Error('must not call any model'); }, candidates.filter(item => item.harness !== 'codex'));
  try { await assert.rejects(unavailable.boss.plan(unavailable.task, unavailable.context), /Codex.*verify-binding|verify-binding.*Codex/i); }
  finally { await unavailable.dispose(); }
});

test('Boss cancellation aborts before any call and between selection and planning; quota remains retryable', async () => {
  const controller = new AbortController();
  let calls = 0;
  const f = await fixture(async () => { calls++; controller.abort(new Error('user cancelled')); return result(selection()); });
  try { f.context.signal = controller.signal; await assert.rejects(f.boss.plan(f.task, f.context), /user cancelled/); assert.equal(calls, 1);
    await assert.rejects(f.boss.plan(f.task, f.context), /user cancelled/); assert.equal(calls, 1); }
  finally { await f.dispose(); }
  const quota = await fixture(async () => ({ status: 'failed', exitCode: 1, durationMs: 1, quota: { source: 'provider_message', retryAt: '2026-11-01T00:00:00Z' } }));
  try { await assert.rejects(quota.boss.plan(quota.task, quota.context), error => error instanceof QuotaLimitError && error.retryAt === '2026-11-01T00:00:00Z'); }
  finally { await quota.dispose(); }
});

test('Boss bounds consultation rounds and replan requests only remaining work', async () => {
  let calls = 0;
  const f = await fixture(async (request, purpose) => {
    calls++;
    if (purpose === 'boss_selection') return result(selection());
    if (purpose === 'boss_consult') return result('independent opinion');
    assert.match(request.prompt, /remaining|剩余/i); assert.match(request.prompt, /completedStages[^\n]*2/);
    return result(consult());
  });
  try { f.context.completedStages = 2; await assert.rejects(f.boss.plan(f.task, f.context), /round|轮|plan/i); assert.equal(calls, 8); }
  finally { await f.dispose(); }
});

test('Boss rechecks exact binding identity before returning a plan and does not reuse a same-ID replacement', async () => {
  const source = candidates.map(candidate => ({ ...candidate, reasoningEfforts: [...candidate.reasoningEfforts] }));
  const f = await fixture(async (_request, purpose) => {
    if (purpose === 'boss_selection') return result(selection());
    source.find(candidate => candidate.bindingId === 'dsh:deepseek')!.configHash = 'replacement-profile';
    return result(plan());
  }, source);
  try { await assert.rejects(f.boss.plan(f.task, f.context), /outside the verified available candidates/); }
  finally { await f.dispose(); }
});

test('Boss explains a feasible lead resolution without locking implementation to the requested lead', async () => {
  const f = await fixture(async (_request, purpose) => result(purpose === 'boss_selection'
    ? selection({ bindingId: 'codex:cheap', reasoningEffort: 'low', reason: 'The requested gpt-99 model is not available; use verified cheap low instead.' }) : plan()));
  try {
    f.task.boss = { preference: 'codex gpt-99 high' };
    const output = await f.boss.plan(f.task, f.context);
    assert.equal(output.boss.model, 'cheap'); assert.equal(output.boss.reasoningEffort, 'low');
    assert.equal(output.stages[0]!.harness, 'dsh');
    assert.match(f.messages[0]!.content, /gpt-99/); assert.match(f.messages[0]!.content, /not available/);
  } finally { await f.dispose(); }
});

test('consultation quota or cancellation stops the decision loop and discards its snapshot', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const calls: Array<{ purpose: string; cwd: string }> = [];
    const f = await fixture(async (request, purpose) => {
      calls.push({ purpose, cwd: request.cwd });
      if (purpose === 'boss_selection') return result(selection());
      if (purpose === 'boss_plan') return result(consult());
      if (cancelled) { controller.abort(new Error('cancel consultation')); return result('discarded opinion'); }
      return { status: 'failed', exitCode: 1, durationMs: 1, quota: { source: 'provider_message' } };
    });
    try {
      f.context.signal = controller.signal;
      await assert.rejects(f.boss.plan(f.task, f.context), error => cancelled ? /cancel consultation/.test(String(error)) : error instanceof QuotaLimitError);
      assert.deepEqual(calls.map(call => call.purpose), ['boss_selection', 'boss_plan', 'boss_consult']);
      for (const call of calls) await assert.rejects(access(call.cwd));
    } finally { await f.dispose(); }
  }
});

test('Boss snapshots preserve deep project files under a long artifact root without copying template hooks', async () => {
  let calls = 0;
  const deepRelative = join('nested-project-directory-'.repeat(4), 'additional-project-directory-'.repeat(4), 'implementation.mjs');
  // Make the artifact location genuinely long on Linux too, while keeping the
  // mkdtemp parent below Windows' directory-creation limit.
  const artifactDirectory = 'long-artifact-location-'.padEnd(Math.max(22, 140 - tmpdir().length - 18), 'x');
  const f = await fixture(async (request, purpose) => {
    calls++;
    assert.ok(request.cwd.length > 170, 'exercise a long real artifact location');
    await assert.rejects(access(join(request.cwd, '.git', 'hooks', 'fsmonitor-watchman.sample')));
    if (purpose === 'boss_selection') return result(selection());
    const copy = join(request.cwd, 'review-context', 'project', deepRelative);
    assert.ok(copy.length > 400, 'preserve an actual deeply nested project file');
    assert.equal(await readFile(copy, 'utf8'), 'export const deep = true;\n');
    return result(plan());
  }, candidates, artifactDirectory);
  try {
    const file = join(f.workspace, deepRelative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'export const deep = true;\n');
    await exec('git', ['-c', 'core.longpaths=true', 'add', '-A'], { cwd: f.workspace, windowsHide: true });
    assert.equal((await f.boss.plan(f.task, f.context)).stages.length, 2);
    assert.equal(calls, 2);
  } finally { await f.dispose(); }
});
