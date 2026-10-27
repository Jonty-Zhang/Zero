import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HarnessAdapter, TaskRecord } from '../domain/types.js';
import { prepareProjectFolder } from '../server/project-folders.js';
import { TaskReviewer, type ReviewerRunContext } from './reviewer.js';

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
