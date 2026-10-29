import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HarnessAdapter, TaskRecord } from '../domain/types.js';
import { prepareProjectFolder } from '../server/project-folders.js';
import { parseReviewOutput, TaskReviewer, type ReviewerRunContext } from './reviewer.js';
import type { ReviewRequirementsSnapshot } from '../domain/review-requirements.js';

const task: TaskRecord = { id: 'requirements-review', repoPath: '.', baseRef: 'HEAD', prompt: 'Live task has changed',
  acceptanceCriteria: ['Live criterion has changed'], boss: { preference: 'lead decides' }, status: 'reviewing',
  revisionCount: 0, createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z' };
const route = { taskId: task.id, harness: 'dsh', model: 'writer', reason: 'fixture',
  selectionSource: 'codex' as const, decidedAt: task.createdAt };
const worktree = { taskId: task.id, repoPath: '.', path: '.', branch: 'zero/test', baseCommit: 'fixture' };
const requirements = () => ({ version: 1, taskId: task.id, prompt: 'Frozen original goal',
  acceptanceCriteria: ['Frozen acceptance'], userMessages: [
    { id: 'human-first', role: 'user', content: 'Preserve Chinese 中文 names\nwith original line breaks', at: task.createdAt },
    { id: 'human-last', role: 'user', content: 'Keep cancellation receipts intact', at: task.updatedAt },
  ], messageCursor: 'human-last' });

const replyRequirements = () => ({ ...requirements(), replyPolicy: 'per_message_v1', replyMessageIds: ['human-last'] }) as ReviewRequirementsSnapshot;
const pass = { verdict: 'pass', summary: 'Verified', findings: [] };
for (const [name, replies] of [
  ['missing', undefined], ['empty', []], ['blank', [{ messageId: 'human-last', content: '  ' }]],
  ['forged', [{ messageId: 'unknown', content: 'answer' }]],
  ['duplicate', [{ messageId: 'human-last', content: 'answer' }, { messageId: 'human-last', content: 'answer' }]],
  ['extra field', [{ messageId: 'human-last', content: 'answer', authority: 'bypass' }]],
  ['oversize', [{ messageId: 'human-last', content: 'x'.repeat(4001) }]],
] as const) test(`linked review output rejects ${name} answers`, () => {
  assert.throws(() => parseReviewOutput(JSON.stringify({ ...pass, ...(replies !== undefined ? { userMessageReplies: replies } : {}) }), replyRequirements()), /repl/i);
});

test('linked replies allow blocked omission but do not allow partial blocked answers or legacy extension fields', () => {
  assert.equal(parseReviewOutput(JSON.stringify({ ...pass, verdict: 'blocked' }), replyRequirements()).verdict, 'blocked');
  assert.throws(() => parseReviewOutput(JSON.stringify({ ...pass, verdict: 'blocked', userMessageReplies: [] }), replyRequirements()), /repl/i);
  assert.throws(() => parseReviewOutput(JSON.stringify({ ...pass, userMessageReplies: [] })), /shape/i);
  assert.deepEqual(parseReviewOutput(JSON.stringify(pass)), pass);
});

test('linked replies reject oversized total UTF-8 output without truncating a target', () => {
  const frozen = replyRequirements();
  frozen.userMessages = Array.from({ length: 12 }, (_, i) => ({ id: `human-${i}`, role: 'user', content: 'Question', at: task.createdAt }));
  frozen.replyMessageIds = frozen.userMessages.map(message => message.id); frozen.messageCursor = 'human-11';
  const replies = frozen.replyMessageIds.map(messageId => ({ messageId, content: '中'.repeat(4000) }));
  assert.throws(() => parseReviewOutput(JSON.stringify({ ...pass, userMessageReplies: replies }), frozen), /limit/i);
});

for (const lead of [undefined, { harness: 'dsh', model: 'other' }, { harness: 'codex', model: '' }]) test(`new reply policy rejects invalid persisted lead ${JSON.stringify(lead)} before any probe`, async () => {
  let probes = 0;
  const codex: HarnessAdapter = { id: 'codex', async probe() { probes++; throw new Error('must not probe'); }, async run() { throw new Error('must not run'); } };
  const current = { ...task, bossPlan: { boss: lead } } as unknown as TaskRecord;
  await assert.rejects(new TaskReviewer({ codex, model: 'global-default', artifactDir: 'not-used' }).review(current, worktree, route, [], '', { requirements: replyRequirements() }), /persisted Boss/i);
  assert.equal(probes, 0);
});

for (const lead of [{ model: 'missing', reasoningEffort: 'high' }, { model: 'lead', reasoningEffort: 'unsupported' }]) test(`unavailable persisted lead cannot fall back to an available worker ${JSON.stringify(lead)}`, async () => {
  let calls = 0;
  const codex: HarnessAdapter = { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['lead', 'writer'], reasoningEfforts: ['high'] }; }, async run() { calls++; throw new Error('must not run'); } };
  const current = { ...task, bossPlan: { boss: { harness: 'codex', ...lead } } } as unknown as TaskRecord;
  await assert.rejects(new TaskReviewer({ codex, model: 'writer', artifactDir: 'not-used' }).review(current, worktree, route, [], '', { requirements: replyRequirements() }), /not a verified|not supported/);
  assert.equal(calls, 0);
});

for (const [name, snapshot] of [
  ['missing', undefined],
  ['another task', { ...requirements(), taskId: 'other-task' }],
  ['incomplete cursor', { ...requirements(), messageCursor: 'unknown' }],
] as const) test(`Boss review rejects ${name} requirements before probing or invoking a model`, async () => {
  let probes = 0;
  const codex: HarnessAdapter = { id: 'codex', async probe() { probes++; throw new Error('must not probe'); },
    async run() { throw new Error('must not run'); } };
  const reviewer = new TaskReviewer({ codex, artifactDir: 'not-used' });
  await assert.rejects(reviewer.review(task, worktree, route, [], '',
    { requirements: snapshot } as unknown as ReviewerRunContext), /requirements/i);
  assert.equal(probes, 0);
});

test('new reply policy uses the persisted Boss and preserves exact replies with failed-check override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zero-linked-replies-'));
  try {
    const repo = join(root, 'project'); await mkdir(repo); await writeFile(join(repo, 'README.md'), 'Offline replies\n'); await prepareProjectFolder(repo);
    const frozen = { ...requirements(), replyPolicy: 'per_message_v1', replyMessageIds: ['human-last'] };
    const replies = [{ messageId: 'human-last', content: 'Cancellation receipts are retained in the database.' }];
    const codex: HarnessAdapter = { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['actual-boss', 'global-default'], reasoningEfforts: ['high', 'low'] }; },
      async run(request) {
        assert.equal(request.model, 'actual-boss'); assert.equal(request.reasoningEffort, 'low');
        const schema = JSON.parse(await readFile(request.outputSchemaPath!, 'utf8'));
        assert.ok(schema.required.includes('userMessageReplies'));
        return { status: 'completed', exitCode: 0, durationMs: 1, final: JSON.stringify({ verdict: 'pass', summary: 'Verified', findings: [], userMessageReplies: replies }) };
      } };
    const leadTask = { ...task, repoPath: repo, bossPlan: { summary: 'Plan', boss: { harness: 'codex', model: 'actual-boss', reasoningEffort: 'low' }, stages: [{}], acceptanceCriteria: ['Complete'], maxRevisions: 1, checks: [] } } as TaskRecord;
    const reviewer = new TaskReviewer({ codex, model: 'global-default', reasoningEffort: 'high', artifactDir: join(root, 'artifacts') });
    const review = await reviewer.review(leadTask, { ...worktree, repoPath: repo, path: repo }, route,
      [{ id: 'unit', argv: [], status: 'failed', exitCode: 1, durationMs: 1 }], '', { requirements: frozen } as unknown as ReviewerRunContext);
    assert.equal(review.result.verdict, 'changes_requested');
    assert.deepEqual(review.result.userMessageReplies, replies);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid linked model output blocks without answers and schemas remain isolated per attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zero-invalid-linked-replies-'));
  try {
    const repo = join(root, 'project'); await mkdir(repo); await writeFile(join(repo, 'README.md'), 'Offline replies\n'); await prepareProjectFolder(repo);
    const schemaPaths: string[] = [];
    const codex: HarnessAdapter = { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['lead'] }; }, async run(request) {
      schemaPaths.push(request.outputSchemaPath!);
      return { status: 'completed', exitCode: 0, durationMs: 1, final: JSON.stringify(pass) };
    } };
    const current = { ...task, repoPath: repo, bossPlan: { boss: { harness: 'codex', model: 'lead' } } } as TaskRecord;
    const reviewer = new TaskReviewer({ codex, artifactDir: join(root, 'artifacts') });
    for (const attemptId of ['first-attempt', 'second-attempt']) {
      const execution = await reviewer.review(current, { ...worktree, repoPath: repo, path: repo }, route, [], '', { attemptId, requirements: replyRequirements() });
      assert.equal(execution.result.verdict, 'blocked'); assert.equal(execution.result.userMessageReplies, undefined);
      assert.match(execution.result.summary, /repl/i);
    }
    assert.notEqual(schemaPaths[0], schemaPaths[1]);
    assert.ok((await readFile(schemaPaths[0]!, 'utf8')).includes('human-last'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('actual reviewer uses the sealed goal and every full human requirement instead of live task fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zero-review-requirements-'));
  try {
    const repo = join(root, 'project');
    await mkdir(repo);
    await writeFile(join(repo, 'README.md'), 'Offline review requirements fixture.\n');
    await prepareProjectFolder(repo);
    const frozen = requirements();
    const expected = structuredClone(frozen);
    let prompt = '';
    const codex: HarnessAdapter = { id: 'codex', async probe() {
      // Async setup must not turn the supplied immutable snapshot into live input.
      frozen.prompt = 'Caller mutated the snapshot after review began';
      frozen.userMessages[0]!.content = 'Caller replaced a requirement';
      return { harness: 'codex', available: true, models: ['reviewer'] };
    }, async run(request) {
      prompt = request.prompt;
      return { status: 'completed', exitCode: 0, durationMs: 1,
        final: JSON.stringify({ verdict: 'pass', summary: 'Offline fixture verdict', findings: [] }) };
    } };
    const reviewer = new TaskReviewer({ codex, artifactDir: join(root, 'artifacts') });
    const result = await reviewer.review({ ...task, repoPath: repo }, { ...worktree, repoPath: repo, path: repo },
      route, [], 'fixture diff', { requirements: frozen } as unknown as ReviewerRunContext);
    assert.equal(result.result.verdict, 'pass');
    const payload = JSON.parse(prompt.split('\n\n').at(-1)!);
    assert.equal(payload.task.prompt, expected.prompt);
    assert.deepEqual(payload.task.acceptanceCriteria, expected.acceptanceCriteria);
    assert.deepEqual(payload.requirements, expected);
    assert.ok(!prompt.includes('Live task has changed'));
    assert.ok(!prompt.includes('Caller replaced a requirement'));
    assert.match(prompt, /supplemental human requirements/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
