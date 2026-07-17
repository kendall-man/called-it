import type {
  ProofSubmissionOutboxDb,
  ProofSubmissionOutboxRow,
  SettlementProofJobRow,
  SettlementProofJobsDb,
} from '@calledit/db';
import { explorerTxUrl } from '../engineConstants.js';
import { isoAt, type DurableQueuePolicy, type RecoveryClock } from '../settle/durable.js';
import type { RecoveryLogger, RecoveredSettlementFact, SettlementFactSource } from '../settle/recovery-types.js';
import type { TxPort } from '../ports.js';
import type {
  DurableProofSubmissionTransport,
  PreparedDurableProofSubmission,
} from './proof-submission.js';
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
  readonly outbox: ProofSubmissionOutboxDb | null;
  readonly facts: SettlementFactSource;
  readonly tx: Pick<TxPort, 'fetchStatProof'>;
  readonly submission: DurableProofSubmissionTransport | null;
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
      } catch (error) {
        options.log.warn('durable_proof_lease_failed', { error: errorMessage(error) });
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
    if (options.outbox === null) {
      await recordUnavailableAndComplete(options, job, fact, null);
      return;
    }
    const existing = await options.outbox.get(job.marketId);
    if (!existing.ok) {
      await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
      return;
    }
    if (existing.outbox !== null) {
      await recoverPersistedSubmission(options, job, fact, existing.outbox);
      return;
    }
    if (options.submission === null) {
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
        await prepareAndRecoverSubmission(options, job, fact, verification.proof);
        return;
    }
  } catch (error) {
    options.log.warn('durable_proof_job_failed', {
      marketId: job.marketId,
      error: errorMessage(error),
    });
    const fact = await options.facts.find(job.marketId).catch(() => null);
    await retryOrDeadLetter(options, job, fact, 'unexpected_error');
  }
}

async function recoverPersistedSubmission(
  options: Parameters<typeof createDurableProofWorker>[0],
  job: SettlementProofJobRow,
  fact: RecoveredSettlementFact,
  outbox: ProofSubmissionOutboxRow,
): Promise<void> {
  const verification = await verifyProofAgainstExpectedRoots(outbox.proofPayload, options.roots);
  switch (verification.kind) {
    case 'payload_invalid':
    case 'root_mismatch':
      await recordUnavailableAndComplete(options, job, fact, outbox.proofPayload);
      return;
    case 'root_unavailable':
      await retryOrDeadLetter(options, job, fact, 'proof_verify_pending');
      return;
    case 'verified':
      await recoverVerifiedSubmission(options, job, fact, outbox, verification.proof);
      return;
  }
}

async function recoverVerifiedSubmission(
  options: Parameters<typeof createDurableProofWorker>[0],
  job: SettlementProofJobRow,
  fact: RecoveredSettlementFact,
  outbox: ProofSubmissionOutboxRow,
  proof: Readonly<Record<string, unknown>>,
): Promise<void> {
  const submissionOutbox = requireOutbox(options);
  if (outbox.state === 'landed') {
    await recordVerifiedAndComplete(options, job, fact, proof, outbox.signature);
    return;
  }
  if (outbox.state === 'expired') {
    await prepareAndRecoverSubmission(options, job, fact, proof);
    return;
  }
  if (options.submission === null) {
    await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
    return;
  }

  const inspected = await options.submission.inspect(toPreparedSubmission(outbox));
  if (!inspected.ok) {
    await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
    return;
  }
  switch (inspected.plan.kind) {
    case 'landed': {
      const landed = await submissionOutbox.markLanded(identityFor(options, outbox));
      if (!landed.ok) {
        await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
        return;
      }
      await recordVerifiedAndComplete(options, job, fact, proof, landed.outbox.signature);
      return;
    }
    case 'onchain_failed': {
      const landed = await submissionOutbox.markLanded(identityFor(options, outbox));
      if (!landed.ok) {
        await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
        return;
      }
      await recordUnavailableAndComplete(options, job, fact, proof);
      return;
    }
    case 'wait':
      await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
      return;
    case 'rebroadcast': {
      const broadcast = await options.submission.rebroadcast(toPreparedSubmission(outbox));
      if (!broadcast.ok) {
        await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
        return;
      }
      const marked = await submissionOutbox.markBroadcast(identityFor(options, outbox));
      if (!marked.ok) {
        await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
        return;
      }
      await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
      return;
    }
    case 'rebuild': {
      const expired = await submissionOutbox.markExpired(identityFor(options, outbox));
      if (!expired.ok) {
        await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
        return;
      }
      await prepareAndRecoverSubmission(options, job, fact, proof);
    }
  }
}

async function prepareAndRecoverSubmission(
  options: Parameters<typeof createDurableProofWorker>[0],
  job: SettlementProofJobRow,
  fact: RecoveredSettlementFact,
  proof: Readonly<Record<string, unknown>>,
): Promise<void> {
  const submissionOutbox = requireOutbox(options);
  if (options.submission === null) {
    await recordUnavailableAndComplete(options, job, fact, proof);
    return;
  }
  const pending = await options.jobs.recordProofState(proofStateInput(options, fact, proof, 'pending'));
  if (!pending.ok && pending.code !== 'proof_fact_conflict') {
    await retryOrDeadLetter(options, job, fact, 'proof_payload_invalid');
    return;
  }
  const built = await options.submission.build({
    fixtureId: fact.fixtureId,
    seq: fact.decidingSeq ?? 0,
    statKey: fact.statKey ?? 0,
    comparator: fact.comparator,
    threshold: fact.threshold,
    proof,
  });
  if (!built.ok) {
    await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
    return;
  }
  const prepared = await submissionOutbox.prepare({
    marketId: job.marketId,
    signature: built.submission.signature,
    rawTxB64: built.submission.rawTxB64,
    lastValidBlockHeight: built.submission.lastValidBlockHeight,
    proofPayload: proof,
    nowIso: isoAt(options.clock.now()),
  });
  if (!prepared.ok) {
    await retryOrDeadLetter(options, job, fact, 'proof_submit_failed');
    return;
  }
  await recoverVerifiedSubmission(options, job, fact, prepared.outbox, proof);
}

async function recordVerifiedAndComplete(
  options: Parameters<typeof createDurableProofWorker>[0],
  job: SettlementProofJobRow,
  fact: RecoveredSettlementFact,
  proof: Readonly<Record<string, unknown>>,
  signature: string,
): Promise<void> {
  const verified = await options.jobs.recordProofState({
    ...proofStateInput(options, fact, proof, 'verified'),
    validateStatTx: signature,
    explorerUrl: explorerTxUrl(signature),
  });
  if (!verified.ok && verified.code !== 'proof_fact_conflict') {
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

function toPreparedSubmission(outbox: ProofSubmissionOutboxRow): PreparedDurableProofSubmission {
  return {
    signature: outbox.signature,
    rawTxB64: outbox.rawTxB64,
    lastValidBlockHeight: outbox.lastValidBlockHeight,
  };
}

function identityFor(
  options: Parameters<typeof createDurableProofWorker>[0],
  outbox: ProofSubmissionOutboxRow,
) {
  return {
    marketId: outbox.marketId,
    attempt: outbox.attempt,
    signature: outbox.signature,
    nowIso: isoAt(options.clock.now()),
  };
}

function requireOutbox(
  options: Parameters<typeof createDurableProofWorker>[0],
): ProofSubmissionOutboxDb {
  if (options.outbox === null) throw new Error('durable proof outbox is unavailable');
  return options.outbox;
}

function retryDelayMs(job: SettlementProofJobRow): number {
  return Math.min(job.retryMaxMs, job.retryBaseMs * 2 ** (job.attempts - 1));
}

function requireLeaseToken(job: SettlementProofJobRow): string {
  if (job.leaseToken === null) throw new Error(`leased proof job ${job.marketId} has no token`);
  return job.leaseToken;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'non_error_throw';
}
