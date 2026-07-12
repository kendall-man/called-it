import type { SettlementProofJobRow, SettlementProofJobsDb } from '@calledit/db';
import { explorerTxUrl } from '../engineConstants.js';
import { isoAt, type DurableQueuePolicy, type RecoveryClock } from '../settle/durable.js';
import type { RecoveryLogger, RecoveredSettlementFact, SettlementFactSource } from '../settle/recovery-types.js';
import type { ProofSubmitter, TxPort } from '../ports.js';
import {
  verifyProofAgainstExpectedRoots,
  type ExpectedScoresRootSource,
} from './verification.js';

export interface DurableProofWorker {
  tick(): Promise<void>;
  heartbeatAtMs(): number | null;
}

export function createDurableProofWorker(options: {
  readonly jobs: SettlementProofJobsDb;
  readonly facts: SettlementFactSource;
  readonly tx: Pick<TxPort, 'fetchStatProof'>;
  readonly submitter: ProofSubmitter | null;
  readonly roots: ExpectedScoresRootSource;
  readonly clock: RecoveryClock;
  readonly policy: DurableQueuePolicy;
  readonly workerId: string;
  readonly leaseLimit: number;
  readonly log: RecoveryLogger;
}): DurableProofWorker {
  let heartbeat: number | null = null;

  return {
    async tick() {
      heartbeat = options.clock.now();
      let jobs: readonly SettlementProofJobRow[];
      try {
        jobs = await options.jobs.leaseJobs({
          jobKind: 'proof',
          workerId: options.workerId,
          nowIso: isoAt(options.clock.now()),
          limit: options.leaseLimit,
        });
      } catch {
        options.log.warn('durable_proof_lease_failed');
        return;
      }

      for (const job of jobs) {
        await processProofJob(options, job);
      }
    },

    heartbeatAtMs() {
      return heartbeat;
    },
  };
}

async function processProofJob(
  options: Parameters<typeof createDurableProofWorker>[0],
  job: SettlementProofJobRow,
): Promise<void> {
  try {
    const fact = await options.facts.find(job.marketId);
    if (fact === null) {
      await retryOrDeadLetter(options, job, null, 'settlement_fact_missing');
      return;
    }
    if (fact.outcome === 'void' || fact.tier === 'oracle_resolved') {
      await completeProofJob(options, job);
      return;
    }
    if (fact.decidingSeq === null || fact.statKey === null) {
      await recordUnavailableAndComplete(options, job, fact, null);
      return;
    }
    if (options.submitter === null) {
      await recordUnavailableAndComplete(options, job, fact, null);
      return;
    }

    const proof = await options.tx.fetchStatProof(fact.fixtureId, fact.decidingSeq, fact.statKey);
    const verification = await verifyProofAgainstExpectedRoots(proof, options.roots);
    switch (verification.kind) {
      case 'payload_invalid':
      case 'root_mismatch':
        await recordUnavailableAndComplete(options, job, fact, null);
        return;
      case 'root_unavailable':
        await retryOrDeadLetter(options, job, fact, 'proof_verify_pending');
        return;
      case 'verified':
        await submitVerifiedProof(options, job, fact, verification.proof);
        return;
    }
  } catch {
    options.log.warn('durable_proof_job_failed', {
      marketId: job.marketId,
    });
    const fact = await options.facts.find(job.marketId).catch(() => null);
    await retryOrDeadLetter(options, job, fact, 'unexpected_error');
  }
}

async function submitVerifiedProof(
  options: Parameters<typeof createDurableProofWorker>[0],
  job: SettlementProofJobRow,
  fact: RecoveredSettlementFact,
  proof: Readonly<Record<string, unknown>>,
): Promise<void> {
  const pending = await options.jobs.recordProofState(proofStateInput(options, fact, proof, 'pending'));
  if (!pending.ok) {
    await retryOrDeadLetter(options, job, fact, 'proof_payload_invalid');
    return;
  }

  const submission = await options.submitter?.submit({
    fixtureId: fact.fixtureId,
    seq: fact.decidingSeq ?? 0,
    statKey: fact.statKey ?? 0,
    comparator: fact.comparator,
    threshold: fact.threshold,
    proof,
  });
  if (submission === undefined || submission.permanent) {
    await recordUnavailableAndComplete(options, job, fact, proof);
    return;
  }
  if (!submission.ok || submission.txSig === undefined || submission.txSig.trim() === '') {
    await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
    return;
  }

  const verified = await options.jobs.recordProofState({
    ...proofStateInput(options, fact, proof, 'verified'),
    validateStatTx: submission.txSig,
    explorerUrl: explorerTxUrl(submission.txSig),
  });
  if (!verified.ok) {
    await retryOrDeadLetter(options, job, fact, 'proof_verify_failed');
    return;
  }
  await completeProofJob(options, job);
}

async function recordUnavailableAndComplete(
  options: Parameters<typeof createDurableProofWorker>[0],
  job: SettlementProofJobRow,
  fact: RecoveredSettlementFact,
  proof: Readonly<Record<string, unknown>> | null,
): Promise<void> {
  const recorded = await recordTerminalProof(options, fact, proof, 'unavailable');
  if (!recorded) {
    await retryOrDeadLetter(options, job, fact, 'proof_verify_failed');
    return;
  }
  await completeProofJob(options, job);
}

async function retryOrDeadLetter(
  options: Parameters<typeof createDurableProofWorker>[0],
  job: SettlementProofJobRow,
  fact: RecoveredSettlementFact | null,
  errorCode:
    | 'settlement_fact_missing'
    | 'proof_payload_invalid'
    | 'proof_submit_failed'
    | 'proof_verify_pending'
    | 'proof_verify_failed'
    | 'unexpected_error',
): Promise<void> {
  const input = {
    marketId: job.marketId,
    jobKind: 'proof' as const,
    workerId: options.workerId,
    leaseToken: requireLeaseToken(job),
    nowIso: isoAt(options.clock.now()),
  };
  if (job.attempts >= job.maxAttempts && fact !== null) {
    const terminal = await recordTerminalProof(options, fact, null, 'failed');
    if (terminal) {
      const dead = await options.jobs.deadLetterJob({ ...input, errorCode });
      if (dead.ok) return;
    }
  }
  const retry = await options.jobs.retryJob({
    ...input,
    errorCode,
    delayMs: retryDelayMs(job),
  });
  if (!retry.ok) {
    options.log.warn('durable_proof_transition_lost', {
      marketId: job.marketId,
      errorCode,
      code: retry.code,
    });
  }
}

async function recordTerminalProof(
  options: Parameters<typeof createDurableProofWorker>[0],
  fact: RecoveredSettlementFact,
  proof: Readonly<Record<string, unknown>> | null,
  status: 'failed' | 'unavailable',
): Promise<boolean> {
  const pending = await options.jobs.recordProofState(proofStateInput(options, fact, proof, 'pending'));
  if (!pending.ok && pending.code !== 'proof_fact_conflict') return false;
  const terminal = await options.jobs.recordProofState(proofStateInput(options, fact, proof, status));
  return terminal.ok || terminal.code === 'proof_fact_conflict';
}

async function completeProofJob(
  options: Parameters<typeof createDurableProofWorker>[0],
  job: SettlementProofJobRow,
): Promise<void> {
  const completed = await options.jobs.completeJob({
    marketId: job.marketId,
    jobKind: 'proof',
    workerId: options.workerId,
    leaseToken: requireLeaseToken(job),
    nowIso: isoAt(options.clock.now()),
  });
  if (!completed.ok) {
    options.log.warn('durable_proof_completion_deferred', {
      marketId: job.marketId,
      code: completed.code,
    });
  }
}

function proofStateInput(
  options: Parameters<typeof createDurableProofWorker>[0],
  fact: RecoveredSettlementFact,
  proof: Readonly<Record<string, unknown>> | null,
  status: 'pending' | 'verified' | 'failed' | 'unavailable',
) {
  return {
    marketId: fact.marketId,
    kind: 'stat' as const,
    statKey: fact.statKey,
    seq: fact.decidingSeq,
    merkleProof: proof,
    validateStatTx: null,
    explorerUrl: null,
    status,
    nowIso: isoAt(options.clock.now()),
  };
}

function retryDelayMs(job: SettlementProofJobRow): number {
  return Math.min(job.retryMaxMs, job.retryBaseMs * 2 ** (job.attempts - 1));
}

function requireLeaseToken(job: SettlementProofJobRow): string {
  if (job.leaseToken === null) throw new Error(`leased proof job ${job.marketId} has no token`);
  return job.leaseToken;
}
