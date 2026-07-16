import type { SettlementProofJobKind, SettlementProofJobsDb } from '@calledit/db';
import type { QueueReadinessPort, QueueReadinessSnapshot } from '../api/readiness-checks.js';
import type { ShutdownDrainPort } from '../api/shutdown.js';
import { isoAt, type DurableQueuePolicy, type RecoveryClock } from './durable.js';
import type { DurableSettlementWorker } from './durable-settlement-worker.js';
import type { RecoveryLogger } from './recovery-types.js';
import type { DurableProofWorker } from '../proofs/durable-proof-worker.js';

export interface DurableSettlementProofRuntime {
  tick(): Promise<void>;
  stop(): void;
  drain(signal: AbortSignal): Promise<void>;
  unfinished(): number;
  readinessPort(kind: SettlementProofJobKind): QueueReadinessPort;
  shutdownDrain(): ShutdownDrainPort;
}

export function createDurableSettlementProofRuntime(options: {
  readonly jobs: SettlementProofJobsDb;
  readonly settlement: DurableSettlementWorker;
  readonly proof: DurableProofWorker;
  readonly clock: RecoveryClock;
  readonly policy: DurableQueuePolicy;
  readonly reconcileLimit: number;
  readonly log: RecoveryLogger;
}): DurableSettlementProofRuntime {
  let stopped = false;
  let running: Promise<void> | null = null;

  const runTick = async (): Promise<void> => {
    try {
      const repaired = await options.jobs.reconcileTerminalJobs({
        nowIso: isoAt(options.clock.now()),
        limit: options.reconcileLimit,
        maxAttempts: options.policy.maxAttempts,
        leaseMs: options.policy.leaseMs,
        retryBaseMs: options.policy.retryBaseMs,
        retryMaxMs: options.policy.retryMaxMs,
        initialChainProofDelayMs: options.policy.initialChainProofDelayMs,
      });
      for (const result of repaired) {
        if (result.reasonCodes.length > 0) {
          options.log.warn('durable_settlement_reconciled', {
            marketId: result.marketId,
            reasons: result.reasonCodes.join(','),
          });
        }
      }
    } catch {
      options.log.warn('durable_settlement_reconcile_failed');
    }

    await runWorker(options.settlement, 'durable_settlement_tick_failed', options.log);
    await runWorker(options.proof, 'durable_proof_tick_failed', options.log);
  };

  return {
    async tick() {
      if (stopped) return;
      if (running !== null) return running;
      running = runTick().finally(() => {
        running = null;
      });
      return running;
    },

    stop() {
      stopped = true;
    },

    async drain(signal) {
      signal.throwIfAborted();
      if (running !== null) await running;
      signal.throwIfAborted();
    },

    unfinished() {
      return running === null ? 0 : 1;
    },

    readinessPort(kind) {
      return {
        snapshot: async (signal) => {
          signal.throwIfAborted();
          const backlog = await options.jobs.backlog(kind, isoAt(options.clock.now()));
          signal.throwIfAborted();
          return snapshotFor(kind, options, backlog);
        },
      };
    },

    shutdownDrain() {
      return {
        name: 'durable_settlement_proof',
        drain: async (signal) => {
          stopped = true;
          signal.throwIfAborted();
          if (running !== null) await running;
          signal.throwIfAborted();
        },
        unfinished: () => (running === null ? 0 : 1),
      };
    },
  };
}

function snapshotFor(
  kind: SettlementProofJobKind,
  options: {
    readonly settlement: DurableSettlementWorker;
    readonly proof: DurableProofWorker;
  },
  backlog: {
    readonly readyCount: number;
    readonly oldestReadyAgeMs: number | null;
    readonly activeLeaseCount: number;
    readonly retryWaitCount: number;
  },
): QueueReadinessSnapshot {
  const heartbeatAtMs = kind === 'settlement'
    ? options.settlement.heartbeatAtMs()
    : options.proof.heartbeatAtMs();
  return {
    enabled: true,
    heartbeatAtMs,
    backlog: backlog.readyCount + backlog.activeLeaseCount + backlog.retryWaitCount,
    oldestAgeMs: backlog.oldestReadyAgeMs,
  };
}

async function runWorker(
  worker: DurableSettlementWorker | DurableProofWorker,
  event: string,
  log: RecoveryLogger,
): Promise<void> {
  try {
    await worker.tick();
  } catch {
    log.warn(event);
  }
}
