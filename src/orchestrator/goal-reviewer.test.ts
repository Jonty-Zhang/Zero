import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { HarnessAdapter, RunRequest, RunResult } from '../domain/types.js';
import { QuotaLimitError } from '../core/quota.js';
import { GoalReviewer } from './goal-reviewer.js';

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error('test repository setup failed');
}

async function repositoryFixture(run: (request: RunRequest) => Promise<RunResult>) {
  const root = await mkdtemp(join(tmpdir(), 'zero-goal-review-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.name', 'Zero Test');
  git(repo, 'config', 'user.email', 'zero-test@localhost');
  await writeFile(join(repo, 'README.md'), 'goal result\n', 'utf8');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '--quiet', '-m', 'fixture');
  const requests: RunRequest[] = [];
  const adapter: HarnessAdapter = {
    id: 'codex',
    async probe() { return { harness: 'codex', models: ['review-model'], reasoningEfforts: ['high'], roles: ['review'], available: true }; },
    async run(request) { requests.push(request); return run(request); },
  };
  return { root, repo, requests, reviewer: new GoalReviewer({ codex: adapter }) };
}

const pass = (): RunResult => ({ status: 'completed', exitCode: 0, durationMs: 2,
  final: JSON.stringify({ verdict: 'pass', summary: 'All criteria are supported.', findings: [] }) });
const reject = (): RunResult => ({ status: 'completed', exitCode: 0, durationMs: 2,
  final: JSON.stringify({ verdict: 'changes_requested', summary: 'A criterion is unmet.', findings: [
    { file: null, line: null, severity: 'high', evidence: 'The promised outcome is absent.', requestedChange: 'Implement the missing outcome.' },
  ] }) });

test('aggregate goal reviewer runs read-only and returns a validated PASS', async () => {
  const f = await repositoryFixture(async () => pass());
  try {
    const result = await f.reviewer.review({ sequenceId: 'goal_1', objective: 'Deliver the outcome', acceptanceCriteria: ['Result exists'],
      stepEvidence: { cumulativeDiff: 'diff --git a/README.md b/README.md' }, workspacePath: f.repo, artifactRoot: join(f.root, 'artifacts') });
    assert.equal(result.result.verdict, 'pass');
    assert.equal(result.verifiedSnapshotFingerprint, result.evidenceFingerprint);
    assert.equal(f.requests[0]?.readOnly, true);
    assert.equal(f.requests[0]?.role, 'review');
    assert.match(f.requests[0]?.prompt ?? '', /Deliver the outcome/);
    assert.match(f.requests[0]?.prompt ?? '', /cumulativeDiff/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('aggregate goal reviewer preserves changes_requested findings', async () => {
  const f = await repositoryFixture(async () => reject());
  try {
    const result = await f.reviewer.review({ sequenceId: 'goal_2', objective: 'Deliver the outcome', stepEvidence: { steps: [] },
      workspacePath: f.repo, artifactRoot: join(f.root, 'artifacts') });
    assert.equal(result.result.verdict, 'changes_requested');
    assert.equal(result.result.findings.length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('aggregate goal reviewer preserves quota retry time for durable caller handling', async () => {
  const retryAt = new Date(Date.now() + 5 * 60 * 60_000).toISOString();
  const f = await repositoryFixture(async () => ({ status: 'failed', exitCode: 1, durationMs: 2, quota: { retryAt, source: 'provider_message' } }));
  try {
    await assert.rejects(() => f.reviewer.review({ sequenceId: 'goal_3', objective: 'Deliver the outcome', stepEvidence: { steps: [] },
      workspacePath: f.repo, artifactRoot: join(f.root, 'artifacts') }), (error: unknown) => error instanceof QuotaLimitError && error.retryAt === retryAt);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
