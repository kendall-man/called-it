import type { QueueReadinessPort, WorkerReadinessPort } from './api/readiness-checks.js';
import type { ShutdownDrainPort } from './api/shutdown.js';
import type { DurableSettlementProofRuntime } from './settle/recovery-runtime.js';
import type { EngineRuntimeOptions, EngineRuntimeTelegramDb } from './runtime.js';
import { TelegramIngressWorker } from './telegram/ingress-worker.js';
import { TelegramOutboundCompletionWorker } from './telegram/outbound-completion-worker.js';
import { OwnedTelegramSender } from './telegram/owned-sender.js';
import { TelegramOwnershipReconciler } from './telegram/ownership-reconciler.js';

const OUTBOUND_BATCH_SIZE = 20;

export interface RuntimeWorkers {
  readonly completion: TelegramOutboundCompletionWorker;
  readonly ingress: TelegramIngressWorker | null;
  readonly outbound: OwnedTelegramSender;
  readonly reconciler: TelegramOwnershipReconciler;
  readonly recovery: DurableSettlementProofRuntime;
}

export function createRuntimeTick(
  options: EngineRuntimeOptions,
  workers: Omit<RuntimeWorkers, 'outbound'>,
): Promise<void> {
  return runRuntimeTick(options, workers);
}

export function createRuntimeReadiness(
  options: EngineRuntimeOptions,
  recovery: DurableSettlementProofRuntime,
  ingressWorkerId: string | null,
): EngineRuntimeReadiness {
  return {
    proof: queueReadiness(
      recovery.readinessPort('proof'),
      options.settlementEnabled && options.proofSubmission !== null,
    ),
    settlement: queueReadiness(recovery.readinessPort('settlement'), options.settlementEnabled),
    telegram: telegramReadiness(options, ingressWorkerId),
  };
}

export function createRuntimeShutdownDrains(
  options: EngineRuntimeOptions,
  workers: RuntimeWorkers,
): readonly ShutdownDrainPort[] {
  return [
    workers.recovery.shutdownDrain(),
    ownershipDrain(options, workers.outbound),
    completionDrain(workers.completion),
    reconciliationDrain(workers.reconciler),
    ...(workers.ingress === null ? [] : [ingressDrain(workers.ingress)]),
  ];
}

export function ownedSenderDb(telegram: EngineRuntimeTelegramDb) {
  return {
    planOutbound: async (input: Parameters<EngineRuntimeTelegramDb['planOutbound']>[0]) => {
      const result = await telegram.planOutbound(input);
      return result.ok ? { ...result, messageId: null } : result;
    },
    startOutbound: (jobId: string, workerId: string, leaseMs: number) =>
      telegram.startOutbound(jobId, workerId, leaseMs),
    markOutboundOwned: (jobId: string, workerId: string, messageId: number) =>
      telegram.markOutboundOwned(jobId, workerId, messageId),
    markOutboundUncertain: (jobId: string, workerId: string, errorCode: string) =>
      telegram.markOutboundUncertain(jobId, workerId, errorCode),
  };
}

export class EngineRuntimeError extends Error {
  readonly name = 'EngineRuntimeError';

  constructor(code: string) {
    super(code);
  }
}

interface EngineRuntimeReadiness {
  readonly proof: QueueReadinessPort;
  readonly settlement: QueueReadinessPort;
  readonly telegram: WorkerReadinessPort;
}

async function runRuntimeTick(
  options: EngineRuntimeOptions,
  workers: Omit<RuntimeWorkers, 'outbound'>,
): Promise<void> {
  await runStage(options, 'telegram_outbound_sweep_failed', () =>
    options.telegram.sweepExpiredOutbound(OUTBOUND_BATCH_SIZE),
  );
  if (workers.ingress !== null) {
    await runStage(options, 'telegram_ingress_tick_failed', () =>
      workers.ingress?.runOnce(new AbortController().signal) ?? Promise.resolve(0),
    );
  }
  await runStage(options, 'telegram_ownership_reconcile_failed', () =>
    workers.reconciler.runOnce(new AbortController().signal),
  );
  await runStage(options, 'telegram_outbound_completion_failed', () =>
    workers.completion.runOnce(new AbortController().signal),
  );
  if (options.settlementEnabled) {
    await runStage(options, 'durable_runtime_tick_failed', () => workers.recovery.tick());
  }
  await runStage(options, 'telegram_outbound_completion_failed', () =>
    workers.completion.runOnce(new AbortController().signal),
  );
}

function queueReadiness(port: QueueReadinessPort, enabled: boolean): QueueReadinessPort {
  return {
    async snapshot(signal) {
      const snapshot = await port.snapshot(signal);
      return { ...snapshot, enabled };
    },
  };
}

function telegramReadiness(
  options: EngineRuntimeOptions,
  workerId: string | null,
): WorkerReadinessPort {
  return {
    async snapshot(signal) {
      signal.throwIfAborted();
      if (workerId === null) return { heartbeatAtMs: null };
      const snapshot = await options.telegram.deliverySnapshot(new Date(options.clock.now()).toISOString());
      signal.throwIfAborted();
      const worker = snapshot.workers.find(
        (candidate) => candidate.workerKind === 'telegram_ingress' && candidate.workerId === workerId,
      );
      return { heartbeatAtMs: worker === undefined ? null : Date.parse(worker.heartbeatAt) };
    },
  };
}

function ownershipDrain(
  options: EngineRuntimeOptions,
  outbound: OwnedTelegramSender,
): ShutdownDrainPort {
  return {
    name: outbound.name,
    async drain(signal) {
      await options.telegram.sweepExpiredOutbound(OUTBOUND_BATCH_SIZE);
      await outbound.drain(signal);
    },
    unfinished: () => outbound.unfinished(),
  };
}

function completionDrain(completion: TelegramOutboundCompletionWorker): ShutdownDrainPort {
  return {
    name: completion.name,
    async drain(signal) {
      await completion.drain(signal);
    },
    unfinished: () => completion.unfinished(),
  };
}

function reconciliationDrain(reconciler: TelegramOwnershipReconciler): ShutdownDrainPort {
  return {
    name: reconciler.name,
    drain: (signal) => reconciler.drain(signal),
    unfinished: () => reconciler.unfinished(),
  };
}

function ingressDrain(ingress: TelegramIngressWorker): ShutdownDrainPort {
  return {
    name: 'telegram_ingress',
    drain: (signal) => ingress.drain(signal),
    unfinished: () => ingress.unfinished(),
  };
}

async function runStage(
  options: EngineRuntimeOptions,
  event: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    options.log.warn(event, { reason: error instanceof Error ? error.name : 'unknown_exception' });
  }
}
