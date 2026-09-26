import type {
  CommitOperationRecord,
  ReviewPackageRecord,
  ReviewRecoveryGitState,
  WorktreeCreationRecord,
} from "../core/task-store.js";
import {
  GitWorktreeManager,
  type ReviewedCommitCandidate,
  type WorktreeCreationEvidence,
  type WorktreeCreationPlan,
  type WorktreeInfo,
  type WorktreeReviewSnapshot,
} from "../core/git-worktree.js";
import type { CheckRunSnapshot } from "../core/task-store.js";

export interface ReviewRecoveryInspection {
  info: WorktreeInfo;
  identity: { checkedAt: string; observed: WorktreeCreationEvidence; fingerprint: string };
  gitState: ReviewRecoveryGitState;
}

/**
 * Reopen and classify a reviewing task using only persisted worktree/package/commit
 * evidence and read-only Git inspection. Any ambiguous branch or operation state
 * throws so the caller can leave the task quarantined.
 */
export async function inspectReviewRecovery(
  manager: GitWorktreeManager,
  creation: WorktreeCreationRecord,
  reviewPackage: ReviewPackageRecord,
  commitOperation?: CommitOperationRecord,
): Promise<ReviewRecoveryInspection> {
  if (creation.status !== "created" || !creation.plan || !creation.observed) {
    throw new Error("Review recovery requires a completed persisted worktree creation record");
  }
  const plan = creation.plan as WorktreeCreationPlan;
  const evidence = creation.observed as WorktreeCreationEvidence;
  const pkg = reviewPackage;
  if (creation.taskId !== pkg.taskId || plan.taskId !== pkg.taskId || !pkg.id || !pkg.snapshot) {
    throw new Error("Review recovery worktree and sealed package identities do not match");
  }
  assertSnapshot(pkg.snapshot);

  const reopened = await manager.reopenFromEvidence(plan, evidence);
  const info = reopened.info;
  const branch = await manager.readTaskBranchHead(info);
  if (branch.ref !== pkg.branchRef || branch.ref !== `refs/heads/${info.branch}`) {
    throw new Error("Review recovery task branch ref does not match the sealed package");
  }

  const packageSnapshot = pkg.snapshot;
  if (packageSnapshot.baseCommit.toLowerCase() !== info.baseCommit.toLowerCase()) {
    throw new Error("Review recovery package base commit does not match the persisted worktree plan");
  }
  const reviewed: WorktreeReviewSnapshot = {
    fingerprint: packageSnapshot.fingerprint,
    diff: packageSnapshot.diff,
    diffHash: packageSnapshot.diffHash,
    treeId: packageSnapshot.treeId,
  };

  let gitState: ReviewRecoveryGitState;
  if (commitOperation) {
    assertCommitOperation(commitOperation, pkg);
    if (commitOperation.status === "intent") {
      if (commitOperation.candidateSha) throw new Error("Commit intent unexpectedly contains a persisted candidate SHA");
      gitState = await inspectPreCommit(manager, info, branch.head, packageSnapshot, reviewed, pkg);
    } else {
      const candidateSha = commitOperation.candidateSha;
      if (!candidateSha || !/^[a-f0-9]{40,64}$/i.test(candidateSha)) {
        throw new Error("Persisted commit candidate is missing a valid candidate SHA");
      }
      const candidate: ReviewedCommitCandidate = {
        branchRef: commitOperation.branchRef,
        preHead: commitOperation.preHead,
        commit: candidateSha,
        treeId: commitOperation.treeId,
        diffHash: commitOperation.diffHash,
        opId: commitOperation.id,
      };

      if (candidateSha.toLowerCase() === packageSnapshot.preHead.toLowerCase()
        || branch.head.toLowerCase() === candidateSha.toLowerCase()) {
        await manager.verifyAppliedReviewedCommitCandidate(info, candidate, reviewed);
        const appliedBranch = await manager.readTaskBranchHead(info);
        if (appliedBranch.ref !== candidate.branchRef
          || appliedBranch.head.toLowerCase() !== candidateSha.toLowerCase()) {
          throw new Error("Applied review candidate ref changed during recovery inspection");
        }
        const checkedAt = new Date().toISOString();
        gitState = {
          kind: "applied_candidate", checkedAt, packageId: pkg.id, commitOperationId: commitOperation.id,
          branchRef: appliedBranch.ref, head: appliedBranch.head, refHead: appliedBranch.head,
          treeId: candidate.treeId, diffHash: candidate.diffHash, candidateSha,
          candidateObjectVerified: true, indexMatchesReviewedTree: true, worktreeClean: true,
        };
      } else {
        if (commitOperation.status === "applied") {
          throw new Error("Applied commit operation does not point at its persisted candidate ref");
        }
        if (branch.head.toLowerCase() !== packageSnapshot.preHead.toLowerCase()) {
          throw new Error("Task branch moved away from both the reviewed pre-HEAD and persisted candidate");
        }
        await assertExactPreCommitSnapshot(manager, info, branch.head, packageSnapshot, reviewed);
        await manager.verifyReviewedCommitCandidateObject(info, candidate, reviewed);
        const checkedAt = new Date().toISOString();
        gitState = {
          kind: "pre_commit", checkedAt, branchRef: branch.ref, head: branch.head,
          treeId: packageSnapshot.treeId, diffHash: packageSnapshot.diffHash, snapshot: packageSnapshot,
        };
      }
    }
  } else {
    gitState = await inspectPreCommit(manager, info, branch.head, packageSnapshot, reviewed, pkg);
  }

  // Take a final identity observation after the Git classification and ensure
  // neither HEAD nor the worktree fingerprint drifted during inspection.
  const finalHead = await manager.readTaskBranchHead(info);
  const checkedAt = new Date().toISOString();
  const currentFingerprint = await manager.fingerprint(info);
  if (finalHead.ref !== branch.ref || finalHead.head.toLowerCase() !== branch.head.toLowerCase()
    || currentFingerprint !== reopened.fingerprint) {
    // On an applied candidate, reopening already fingerprints the committed
    // worktree; comparing it here detects races without consulting the old review
    // fingerprint, which is intentionally stale after CAS.
    throw new Error("Worktree identity or task branch changed during review recovery inspection");
  }
  return {
    info,
    identity: { checkedAt, observed: reopened, fingerprint: reopened.fingerprint },
    gitState: { ...gitState, checkedAt } as ReviewRecoveryGitState,
  };
}

async function inspectPreCommit(
  manager: GitWorktreeManager,
  info: WorktreeInfo,
  head: string,
  snapshot: CheckRunSnapshot,
  reviewed: WorktreeReviewSnapshot,
  reviewPackage: ReviewPackageRecord,
): Promise<ReviewRecoveryGitState> {
  if (head.toLowerCase() !== snapshot.preHead.toLowerCase()) {
    throw new Error("Task branch no longer points at the sealed package pre-HEAD");
  }
  await assertExactPreCommitSnapshot(manager, info, head, snapshot, reviewed);
  const branch = await manager.readTaskBranchHead(info);
  const checkedAt = new Date().toISOString();
  if (branch.head.toLowerCase() !== head.toLowerCase() || branch.ref !== reviewPackage.branchRef) {
    throw new Error("Task branch changed during pre-commit recovery inspection");
  }
  return {
    kind: "pre_commit", checkedAt, branchRef: branch.ref, head: branch.head,
    treeId: snapshot.treeId, diffHash: snapshot.diffHash, snapshot,
  };
}

async function assertExactPreCommitSnapshot(
  manager: GitWorktreeManager,
  info: WorktreeInfo,
  head: string,
  expected: CheckRunSnapshot,
  reviewed: WorktreeReviewSnapshot,
): Promise<void> {
  if (head.toLowerCase() !== expected.preHead.toLowerCase()) {
    throw new Error("Task branch no longer points at the sealed package pre-HEAD");
  }
  const current = await manager.captureReviewSnapshot(info);
  if (current.fingerprint !== expected.fingerprint || current.treeId.toLowerCase() !== expected.treeId.toLowerCase()
    || current.diffHash.toLowerCase() !== expected.diffHash.toLowerCase() || current.diff !== expected.diff
    || reviewed.fingerprint !== expected.fingerprint || reviewed.treeId !== expected.treeId
    || reviewed.diffHash !== expected.diffHash || reviewed.diff !== expected.diff) {
    throw new Error("Fresh pre-commit worktree does not match the complete immutable review package snapshot");
  }
}

function assertCommitOperation(operation: CommitOperationRecord, pkg: ReviewPackageRecord): void {
  if (operation.taskId !== pkg.taskId || operation.packageId !== pkg.id
    || operation.branchRef !== pkg.branchRef || operation.preHead.toLowerCase() !== pkg.snapshot.preHead.toLowerCase()
    || operation.treeId.toLowerCase() !== pkg.snapshot.treeId.toLowerCase()
    || operation.diffHash.toLowerCase() !== pkg.snapshot.diffHash.toLowerCase()
    || !["intent", "candidate", "applied"].includes(operation.status)) {
    throw new Error("Persisted commit operation does not match the sealed review package");
  }
}

function assertSnapshot(snapshot: CheckRunSnapshot): void {
  if (!snapshot || typeof snapshot.baseCommit !== "string" || !/^[a-f0-9]{40,64}$/i.test(snapshot.baseCommit)
    || typeof snapshot.preHead !== "string" || !/^[a-f0-9]{40,64}$/i.test(snapshot.preHead)
    || typeof snapshot.treeId !== "string" || !/^[a-f0-9]{40,64}$/i.test(snapshot.treeId)
    || typeof snapshot.fingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(snapshot.fingerprint)
    || typeof snapshot.diffHash !== "string" || !/^[a-f0-9]{64}$/i.test(snapshot.diffHash)
    || typeof snapshot.diff !== "string") {
    throw new Error("Sealed review package contains an invalid Git snapshot");
  }
}
