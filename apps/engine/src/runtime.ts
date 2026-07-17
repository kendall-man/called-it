import type { ProofSubmissionOutboxDb, SettlementProofJobsDb, TelegramDb } from '@calledit/db';
import type { QueueReadinessPort, WorkerReadinessPort } from './api/readiness-checks.js';
import type { ShutdownDrainPort } from './api/shutdown.js';
import type { OwnedPoster } from './bot/poster.js';
import { createDurableProofWorker } from './proofs/durable-proof-worker.js';
import type { DurableProofSubmissionTransport } from './proofs/proof-submission.js';
import type { ExpectedScoresRootSource } from './proofs/verification.js';
import type { TxPort } from './ports.js';
import { createDurableSettlementWorker } from './settle/durable-settlement-worker.js';
import { createDurableSettlementProofRuntime } from './settle/recovery-runtime.js';
import type {
  RecoveryClock,
  DurableQueuePolicy,
  SettlementJournal,
} from './settle/durable.js';
import { createSettlementJournal } from './settle/durable.js';
import type {
  RecoveryLogger,
  SettlementEffects,
  SettlementFactSource,
  SettlementReceiptDelivery,
} from './settle/recovery-types.js';
import { TelegramIngressWorker, type TelegramIngressHandler } from './telegram/ingress-worker.js';
import { TelegramOutboundCompletionWorker } from './telegram/outbound-completion-worker.js';
import { OwnedTelegramSender } from './telegram/owned-sender.js';
import {
  createMarketCardOwnershipResolver,
  createTelegramOwnershipReconciler,
  type MarketCardEvidencePort,
} from './telegram/ownership-reconciler.js';
import {
  EngineRuntimeError,
  createRuntimeReadiness,
  createRuntimeShutdownDrains,
  createRuntimeTick,
  ownedSenderDb,
} from './runtime-support.js';

const OUTBOUND_BATCH_SIZE = 20;

export interface EngineRuntimeQueuePolicy extends DurableQueuePolicy {
  readonly batchSize: number;
  readonly reconcileLimit: number;
}

export type EngineRuntimeTelegramDb = Pick<
  TelegramDb,
  | 'completeOutbound'
  | 'completeUpdate'
  | 'deliverySnapshot'
  | 'heartbeatWorker'
  | 'leaseOutboundCompletion'
  | 'leaseUncertainOwnership'
  | 'leaseUpdates'
  | 'manualReviewOutbound'
  | 'markOutboundOwned'
  | 'markOutboundUncertain'
  | 'persistUpdate'
  | 'planOutbound'
  | 'reconcileOutbound'
  | 'retryUpdate'
  | 'deadLetterUpdate'
  | 'startOutbound'
  | 'sweepExpiredOutbound'
>;

export interface EngineRuntimeOptions {
  readonly jobs: SettlementProofJobsDb;
  readonly proofSubmissionOutbox: ProofSubmissionOutboxDb;
  readonly telegram: EngineRuntimeTelegramDb;
  readonly facts: SettlementFactSource;
  readonly effects: SettlementEffects;
  readonly receipts: SettlementReceiptDelivery;
  readonly tx: Pick<TxPort, 'fetchStatProof'>;
  readonly proofSubmission: DurableProofSubmissionTransport | null;
  readonly roots: ExpectedScoresRootSource;
  readonly marketEvidence: MarketCardEvidencePort;
  readonly poster: Pick<OwnedPoster, 'configureOutboundOwnership'>;
  readonly clock: RecoveryClock;
  readonly policy: EngineRuntimeQueuePolicy;
  readonly log: RecoveryLogger;
  readonly workerId: string;
  readonly settlementEnabled: boolean;
  readonly ingressHandler?: TelegramIngressHandler;
}

export interface EngineRuntime {
  readonly journal: SettlementJournal | null;
  readonly readiness: {
    readonly proof: QueueReadinessPort;
    readonly settlement: QueueReadinessPort;
    readonly telegram: WorkerReadinessPort;
  };
  tick(): Promise<void>;
  stop(): void;
  shutdownDrains(): readonly ShutdownDrainPort[];
}

export function createEngineRuntime(options: EngineRuntimeOptions): EngineRuntime {
  const workerId = options.workerId;
  const journal = options.settlementEnabled
    ? createSettlementJournal({ jobs: options.jobs, clock: options.clock, policy: options.policy })
    : null;
  const settlement = createDurableSettlementWorker({
    jobs: options.jobs,
    facts: options.facts,
    effects: options.effects,
    receipts: options.receipts,
    clock: options.clock,
    policy: options.policy,
    workerId: `${workerId}:settlement`,
    leaseLimit: options.policy.batchSize,
    log: options.log,
  });
  const proof = createDurableProofWorker({
    jobs: options.jobs,
    outbox: options.proofSubmissionOutbox,
    facts: options.facts,
    tx: options.tx,
    submission: options.proofSubmission ?? null,
    roots: options.roots,
    clock: options.clock,
    policy: options.policy,
    workerId: `${workerId}:proof`,
    leaseLimit: options.policy.batchSize,
    log: options.log,
  });
  const recovery = createDurableSettlementProofRuntime({
    jobs: options.jobs,
    settlement,
    proof,
    clock: options.clock,
    policy: options.policy,
    reconcileLimit: options.policy.reconcileLimit,
    log: options.log,
  });
  const outbound = new OwnedTelegramSender({
    db: ownedSenderDb(options.telegram),
    workerId,
    leaseMs: options.policy.leaseMs,
    retryDelayMs: options.policy.retryBaseMs,
  });
  options.poster.configureOutboundOwnership(outbound);
  const completion = new TelegramOutboundCompletionWorker({
    db: options.telegram,
    handlers: {
      group_ready: async () => undefined,
      market_card: async () => undefined,
      settlement_receipt: async (job) => {
        const posted = await options.jobs.markSettlementPosted(
          job.domainId,
          new Date(options.clock.now()).toISOString(),
        );
        if (!posted.ok) throw new EngineRuntimeError('settlement_receipt_marker_missing');
      },
    },
    workerId,
    batchSize: OUTBOUND_BATCH_SIZE,
    leaseMs: options.policy.leaseMs,
    retryDelayMs: options.policy.retryBaseMs,
  });
  const reconciler = createTelegramOwnershipReconciler({
    db: options.telegram,
    resolvers: {
      market_card: createMarketCardOwnershipResolver(options.marketEvidence),
    },
    workerId,
    batchSize: OUTBOUND_BATCH_SIZE,
    leaseMs: options.policy.leaseMs,
    maxAttempts: options.policy.maxAttempts,
  });
  const ingress = options.ingressHandler === undefined
    ? null
    : new TelegramIngressWorker({
      db: options.telegram,
      handler: options.ingressHandler,
      logger: options.log,
      clock: options.clock,
      random: { next: Math.random },
      queuePolicy: {
        batchSize: options.policy.batchSize,
        leaseMs: options.policy.leaseMs,
        maxAttempts: options.policy.maxAttempts,
        retryBaseMs: options.policy.retryBaseMs,
        retryMaxMs: options.policy.retryMaxMs,
      },
      workerId,
    });
  let stopped = false;
  let running: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (running !== null) return running;
    running = createRuntimeTick(options, { ingress, reconciler, completion, recovery }).finally(() => {
      running = null;
    });
    return running;
  };

  return {
    journal,
    readiness: createRuntimeReadiness(options, recovery, ingress === null ? null : workerId),
    tick,
    stop() {
      stopped = true;
      recovery.stop();
      completion.stopLeasing();
      reconciler.stopLeasing();
      ingress?.stopLeasing();
    },
    shutdownDrains: () => createRuntimeShutdownDrains(
      options,
      { outbound, completion, reconciler, recovery, ingress },
    ),
  };
}
