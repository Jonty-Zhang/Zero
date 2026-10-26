import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../adapters/codex.js';
import type { Invocation, ModelBinding, ReasoningEffort, RunContext } from '../adapters/types.js';
import type { TaskRecord } from '../domain/types.js';
import { GoalReviewer } from './goal-reviewer.js';
import { chooseReviewerReasoningEffort, TaskReviewer } from './reviewer.js';

const version = 'offline-codex-fixture-1';
const model = 'a-review';
const executorModel = 'z-executor';
const binding = (id: string, efforts: ReasoningEffort[], cliVersion = version): ModelBinding => ({
  harness: 'codex', selector: 'cli_argument', verified: true, verificationSource: 'smoke_test',
  model: { id, provider: 'openai', modelId: `offline-${id}` },
  verifiedCliVersion: cliVersion, reasoningEfforts: efforts,
});

/** Real Codex probe, binding resolution and prepare; only CLI help/output are offline fixtures. */
class OfflineCodex extends CodexAdapter {
  prepared: Invocation[] = [];
  async command(args: string[]) {
    return { code: 0, stdout: args[0] === '--version' ? version
      : '--json --model --sandbox --cd --output-schema -c --ignore-user-config --ephemeral', stderr: '' };
  }
  async prepare(context: RunContext, selected: ModelBinding): Promise<Invocation> {
    const invocation = await super.prepare(context, selected);
    this.prepared.push(invocation);
    return { ...invocation, executable: process.execPath, args: ['-e',
      `console.log(JSON.stringify({type:'result',model:${JSON.stringify(selected.model.modelId)},text:JSON.stringify({verdict:'pass',summary:'Offline review completed.',findings:[]})}))`],
      stdin: undefined };
  }
}

async function fixture(efforts: ReasoningEffort[]) {
  const root = await mkdtemp(join(tmpdir(), 'zero-review-model-effort-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  await writeFile(join(repo, 'README.md'), 'Offline project for reviewer selection.\n');
  git('add', 'README.md');
  git('-c', 'user.name=Zero Test', '-c', 'user.email=zero-test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const codex = new OfflineCodex({ bindings: [binding(model, efforts), binding(executorModel, ['high']),
    binding('stale-model', ['xhigh'], 'old-cli-version')] });
  const task: TaskRecord = { id: 'effort-task', repoPath: repo, baseRef: 'HEAD', prompt: 'Verify the delivered project.',
    status: 'reviewing', revisionCount: 0, createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' };
  const review = (kind: 'task' | 'goal', reasoningEffort?: string, requestedModel: string | null = model) => kind === 'task'
    ? new TaskReviewer({ codex, artifactDir: join(root, 'artifacts'), model: requestedModel ?? undefined, reasoningEffort }).review(task,
      { taskId: task.id, repoPath: repo, path: repo, branch: 'zero/effort-task', baseCommit: 'fixture' },
      { taskId: task.id, harness: 'codex', model: executorModel, reason: 'Offline fixture', selectionSource: 'codex', decidedAt: task.createdAt }, [], '')
    : new GoalReviewer({ codex, model: requestedModel ?? undefined, reasoningEffort }).review({ sequenceId: 'effort-goal',
      objective: task.prompt, stepEvidence: { tasks: [task.id] }, workspacePath: repo, artifactRoot: join(root, 'artifacts') });
  return { root, codex, review };
}

for (const kind of ['task', 'goal'] as const) {
  for (const efforts of [['medium'], ['low'], [], ['high'], ['max']] as ReasoningEffort[][]) {
    test(`${kind} review uses its own verified model efforts: ${efforts.join(',') || 'CLI default'}`, async () => {
      const f = await fixture(efforts);
      try {
        const result = await f.review(kind);
        assert.equal(result.result.verdict, 'pass', result.result.summary);
        assert.equal(f.codex.prepared.length, 1);
        const args = f.codex.prepared[0]!.args;
        const actual = args.find(arg => arg.startsWith('model_reasoning_effort='));
        assert.equal(actual, efforts[0] ? `model_reasoning_effort=${efforts[0]}` : undefined);
        assert.ok(args.includes('--ignore-user-config'));
        assert.ok(args.includes('read-only'));
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  test(`${kind} review rejects an effort verified only on another model before invoking Codex`, async () => {
    const f = await fixture(['medium']);
    try {
      await assert.rejects(f.review(kind, 'high'), /reasoning effort.*(unavailable|not supported|not verified)/i);
      assert.equal(f.codex.prepared.length, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test(`${kind} review also respects verified effort when the model is selected automatically`, async () => {
    const f = await fixture(['medium']);
    try {
      const result = await f.review(kind, undefined, null);
      assert.equal(result.result.verdict, 'pass', result.result.summary);
      assert.equal(f.codex.prepared[0]?.requestedModel, `offline-${model}`);
      assert.equal(f.codex.prepared[0]?.reasoningEffort, 'medium');
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test('Codex probe reports per-model efforts only for bindings verified for its current CLI version', async () => {
  const codex = new OfflineCodex({ bindings: [binding(model, ['medium']), binding(executorModel, ['high']),
    binding('stale-model', ['xhigh'], 'old-cli-version')] });
  const capabilities = await codex.probe();
  assert.deepEqual(capabilities.models, [model, executorModel]);
  assert.deepEqual(Reflect.get(capabilities, 'modelReasoningEfforts'), { [model]: ['medium'], [executorModel]: ['high'] });
});

test('review effort keeps legacy capability compatibility and treats an explicit model map as authoritative', () => {
  const caps = { harness: 'codex', models: [model], available: true, reasoningEfforts: ['low', 'medium', 'high'] };
  assert.equal(chooseReviewerReasoningEffort(caps, model), 'high');
  assert.equal(chooseReviewerReasoningEffort({ ...caps, modelReasoningEfforts: { [model]: ['low', 'medium'] } }, model), 'medium');
  assert.equal(chooseReviewerReasoningEffort({ ...caps, modelReasoningEfforts: {} }, model), undefined);
  assert.throws(() => chooseReviewerReasoningEffort({ ...caps, modelReasoningEfforts: {} }, model, 'high'), /not supported/);
});

test('Codex probe preserves the existing implicit capability default of manual bindings', async () => {
  const codex = new OfflineCodex({ bindings: [{ harness: 'codex', selector: 'cli_argument', verified: true,
    model: { id: model, provider: 'openai', modelId: 'offline-manual' } }] });
  const caps = await codex.probe();
  assert.equal(chooseReviewerReasoningEffort(caps, model), 'high');
  const invocation = await codex.prepare({ taskId: 'manual', attemptId: 'manual', role: 'review', cwd: process.cwd(),
    prompt: 'offline', reasoningEffort: 'high' }, { harness: 'codex', selector: 'cli_argument', verified: true,
    model: { id: model, provider: 'openai', modelId: 'offline-manual' } });
  assert.equal(invocation.reasoningEffort, 'high');
});
