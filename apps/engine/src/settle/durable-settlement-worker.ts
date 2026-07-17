import type { SettlementProofJobRow, SettlementProofJobsDb } from '@calledit/db';
import { isoAt, type DurableQueuePolicy, type RecoveryClock } from './durable.js';
import type {
  RecoveryLogger,
  SettlementEffects,
  SettlementFactSource,
  SettlementReceiptDelivery,
} from './recovery-types.js';

export interface DurableSettlementWorker {
  tick(): Promise<void>;
  heartbeatAtMs(): number | null;
}

export function createDurableSettlementWorker(options: {
  readonly jobs: SettlementProofJobsDb;
  readonly facts: SettlementFactSource;
  readonly effects: SettlementEffects;
  readonly receipts: SettlementReceiptDelivery;
  readonly clock: RecoveryClock;
  readonly policy: DurableQueuePolicy;
  readonly workerId: string;
  readonly leaseLimit: number;
  readonly log: RecoveryLogger;
}): DurableSettlementWorker {
  let heartbeat: number | null = null;

  return {
    async tick() {
      heartbeat = options.clock.now();
      let jobs: readonly SettlementProofJobRow[];
      try {
        jobs = await options.jobs.leaseJobs({
          jobKind: 'settlement',
          workerId: options.workerId,
          nowIso: isoAt(options.clock.now()),
          limit: options.leaseLimit,
        });
      } catch {
        options.log.warn('durable_settlement_lease_failed');
        return;
      }

      for (const job of jobs) {
        await processSettlementJob(options, job);
      }
    },

    heartbeatAtMs() {
      return heartbeat;
    },
  };
}

async function processSettlementJob(
  options: Parameters<typeof createDurableSettlementWorker>[0],
  job: SettlementProofJobRow,
): Promise<void> {
  try {
    const fact = await options.facts.find(job.marketId);
    if (fact === null) {
      await transitionFailure(options, job, 'settlement_fact_missing');
      return;
    }

    await options.effects.apply(job.marketId);
    const enqueued = await options.jobs.enqueueJob({
      marketId: job.marketId,
      jobKind: 'proof',
      dueAtIso: isoAt(proofDueAtMs(options, fact.outcome, fact.tier)),
      nowIso: isoAt(options.clock.now()),
      maxAttempts: options.policy.maxAttempts,
      leaseMs: options.policy.leaseMs,
      retryBaseMs: options.policy.retryBaseMs,
      retryMaxMs: options.policy.retryMaxMs,
    });
    if (!enqueued.ok) {
      await transitionFailure(options, job, 'proof_enqueue_failed');
      return;
    }

    const delivery = await options.receipts.deliver(fact);
    if (delivery === 'pending') {
      await transitionFailure(options, job, 'chat_ownership_pending');
      return;
    }

    const posted = await options.jobs.markSettlementPosted(job.marketId, isoAt(options.clock.now()));
    if (!posted.ok) {
      await transitionFailure(options, job, 'settlement_fact_missing');
      return;
    }

    const completed = await options.jobs.completeJob({
      marketId: job.marketId,
      jobKind: 'settlement',
      workerId: options.workerId,
      leaseToken: requireLeaseToken(job),
      nowIso: isoAt(options.clock.now()),
    });
    if (!completed.ok) {
      await transitionFailure(options, job, 'wager_apply_failed');
      return;
    }
    options.log.info('durable_settlement_complete', { marketId: job.marketId });
  } catch {
    options.log.warn('durable_settlement_job_failed', {
      marketId: job.marketId,
    });
    await transitionFailure(options, job, 'unexpected_error');
  }
}

function proofDueAtMs(
  options: Parameters<typeof createDurableSettlementWorker>[0],
  outcome: 'claim_won' | 'claim_lost' | 'void',
  tier: 'chain_proven' | 'oracle_resolved',
): number {
  if (outcome === 'void' || tier === 'oracle_resolved') return options.clock.now();
  return options.clock.now() + options.policy.initialChainProofDelayMs;
}

async function transitionFailure(
  options: Parameters<typeof createDurableSettlementWorker>[0],
  job: SettlementProofJobRow,
  errorCode:
    | 'settlement_fact_missing'
    | 'wager_apply_failed'
    | 'proof_enqueue_failed'
    | 'chat_ownership_pending'
    | 'unexpected_error',
): Promise<void> {
  const result = await options.jobs.retryJob({
    marketId: job.marketId,
    jobKind: 'settlement',
    workerId: options.workerId,
    leaseToken: requireLeaseToken(job),
    errorCode,
    delayMs: retryDelayMs(job),
    nowIso: isoAt(options.clock.now()),
  });
  if (!result.ok) {
    options.log.warn('durable_settlement_transition_lost', {
      marketId: job.marketId,
      errorCode,
      code: result.code,
    });
  }
}

function retryDelayMs(job: SettlementProofJobRow): number {
  return Math.min(job.retryMaxMs, job.retryBaseMs * 2 ** (job.attempts - 1));
}

function requireLeaseToken(job: SettlementProofJobRow): string {
  if (job.leaseToken === null) throw new Error(`leased settlement job ${job.marketId} has no token`);
  return job.leaseToken;
}
