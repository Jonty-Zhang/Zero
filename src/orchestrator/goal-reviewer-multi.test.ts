import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HarnessAdapter, RunRequest } from '../domain/types.js';
import { GoalReviewer, goalReviewInputFingerprint } from './goal-reviewer.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zero-multi-review-'));
  const repositories = [];
  for (const [index, content] of ['server result', 'client result'].entries()) {
    const repo = join(root, `source-${index}`);
    await mkdir(repo);
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@localhost']]) {
      execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
    }
    await writeFile(join(repo, 'result.txt'), content);
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo, windowsHide: true });
    repositories.push({ repositoryId: `repo-${index + 1}`, targetTaskId: `task-${index + 1}`, taskWorkspace: repo });
  }
  return { root, repositories };
}

const finding = { file: 'result.txt', line: 1, severity: 'high', evidence: 'Missing server detail', requestedChange: 'Complete the server detail' };

test('multi-repository reviewer reads every namespaced snapshot and accepts a repository-specific target', async () => {
  const f = await fixture();
  try {
    const adapter: HarnessAdapter = {
      id: 'codex',
      async probe() { return { harness: 'codex', available: true, models: ['review'], roles: ['review'] }; },
      async run(request) {
        assert.equal(request.readOnly, true);
        assert.equal(await readFile(join(request.cwd, 'review-context/projects/repo-1/project/result.txt'), 'utf8'), 'server result');
        assert.equal(await readFile(join(request.cwd, 'review-context/projects/repo-2/project/result.txt'), 'utf8'), 'client result');
        const schema = JSON.parse(await readFile(request.outputSchemaPath!, 'utf8'));
        assert.ok(schema.required.includes('targetTaskId'));
        assert.match(request.prompt, /task-1/);
        assert.match(request.prompt, /task-2/);
        return { status: 'completed', exitCode: 0, durationMs: 1,
          final: JSON.stringify({ verdict: 'changes_requested', summary: 'Fix server only', findings: [finding], targetTaskId: 'task-1' }) };
      },
    };
    const input = { sequenceId: 'multi', objective: 'Connect server and client', stepEvidence: { steps: [] },
      workspacePath: f.repositories[0]!.taskWorkspace, repositories: f.repositories, artifactRoot: join(f.root, 'artifacts') };
    const result = await new GoalReviewer({ codex: adapter }).review(input);
    assert.equal(result.result.verdict, 'changes_requested');
    assert.equal((result.result as { targetTaskId?: string }).targetTaskId, 'task-1');
    assert.equal(result.verifiedSnapshotFingerprint, result.evidenceFingerprint);
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('multi-repository protocol refuses missing, foreign and inappropriate targets', async t => {
  const f = await fixture();
  try {
    for (const [name, verdict] of Object.entries({
      missing: { verdict: 'changes_requested', summary: 'Fix it', findings: [finding] },
      foreign: { verdict: 'changes_requested', summary: 'Fix it', findings: [finding], targetTaskId: 'foreign' },
      nullChange: { verdict: 'changes_requested', summary: 'Fix it', findings: [finding], targetTaskId: null },
      passTarget: { verdict: 'pass', summary: 'Done', findings: [], targetTaskId: 'task-1' },
      passMissing: { verdict: 'pass', summary: 'Done', findings: [] },
      blockedTarget: { verdict: 'blocked', summary: 'Need evidence', findings: [], targetTaskId: 'task-1' },
      extraKey: { verdict: 'pass', summary: 'Done', findings: [], targetTaskId: null, command: 'run this' },
    })) await t.test(name, async () => {
      const adapter: HarnessAdapter = { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['review'] }; },
        async run() { return { status: 'completed', exitCode: 0, durationMs: 1, final: JSON.stringify(verdict) }; } };
      const input = { sequenceId: name, stepEvidence: {}, workspacePath: f.repositories[0]!.taskWorkspace,
        repositories: f.repositories, artifactRoot: join(f.root, name) };
      const result = await new GoalReviewer({ codex: adapter }).review(input);
      assert.equal(result.result.verdict, 'blocked', name);
      assert.equal((result.result as { targetTaskId?: string }).targetTaskId, undefined);
    });
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('single explicit source overrides legacy workspace and immutable input survives provider mutation', async () => {
  const f = await fixture();
  try {
    const input = { sequenceId: 'immutable', objective: 'Original objective', stepEvidence: { source: 'original' },
      workspacePath: join(f.root, 'missing'), repositories: [f.repositories[0]!], artifactRoot: join(f.root, 'artifacts') };
    const expectedFingerprint = goalReviewInputFingerprint(input);
    const adapter: HarnessAdapter = { id: 'codex', async probe() {
      input.objective = 'mutated objective'; input.stepEvidence.source = 'mutated';
      return { harness: 'codex', available: true, models: ['review'] };
    }, async run(request: RunRequest) {
      assert.equal(await readFile(join(request.cwd, 'review-context/project/result.txt'), 'utf8'), 'server result');
      assert.match(request.prompt, /Original objective/);
      assert.doesNotMatch(request.prompt, /mutated objective/);
      return { status: 'completed', exitCode: 0, durationMs: 1, final: JSON.stringify({ verdict: 'pass', summary: 'Complete', findings: [] }) };
    } };
    const result = await new GoalReviewer({ codex: adapter }).review(input);
    assert.equal(result.result.verdict, 'pass');
    assert.equal(result.inputFingerprint, expectedFingerprint);
    assert.notEqual(result.inputFingerprint, goalReviewInputFingerprint(input));
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5 }); }
});
