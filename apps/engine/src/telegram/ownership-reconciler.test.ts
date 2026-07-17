import { describe, expect, it } from 'vitest';
import {
  createMarketCardOwnershipResolver,
  createTelegramOwnershipReconciler,
  type TelegramOwnershipMutationResult,
  type TelegramOwnershipReconcilerPort,
  type TelegramOwnershipReconciliationJob,
} from './ownership-reconciler.js';

const WORKER_ID = '00000000-0000-4000-8000-000000000001';

function createJob(input: Partial<TelegramOwnershipReconciliationJob> = {}): TelegramOwnershipReconciliationJob {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    chatId: -1001,
    domainKind: 'market_card',
    domainId: 'market-1',
    reconcileAttempts: 1,
    ...input,
  };
}

function createFakeDb(batches: readonly (readonly TelegramOwnershipReconciliationJob[])[]) {
  const remainingBatches = [...batches];
  const heartbeats: Array<{ readonly workerKind: string; readonly workerId: string; readonly stopping: boolean }> = [];
  const leases: Array<readonly [string, number, number]> = [];
  const reconciled: Array<{ readonly jobId: string; readonly workerId: string; readonly messageId: number }> = [];
  const manualReview: Array<{ readonly jobId: string; readonly workerId: string; readonly errorCode: string }> = [];
  const calls = {
    heartbeats,
    leases,
    reconciled,
    manualReview,
  };
  const db = {
    heartbeatWorker: async (workerKind: string, workerId: string, stopping: boolean) => {
      calls.heartbeats.push({ workerKind, workerId, stopping });
    },
    leaseUncertainOwnership: async (workerId: string, limit: number, leaseMs: number) => {
      calls.leases.push([workerId, limit, leaseMs]);
      return remainingBatches.shift() ?? [];
    },
    reconcileOutbound: async (
      jobId: string,
      workerId: string,
      messageId: number,
    ): Promise<TelegramOwnershipMutationResult> => {
      calls.reconciled.push({ jobId, workerId, messageId });
      return { ok: true };
    },
    manualReviewOutbound: async (
      jobId: string,
      workerId: string,
      errorCode: string,
    ): Promise<TelegramOwnershipMutationResult> => {
      calls.manualReview.push({ jobId, workerId, errorCode });
      return { ok: true };
    },
  } satisfies TelegramOwnershipReconcilerPort;
  return { db, calls };
}

function createDeferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (resolvePromise === undefined) {
        throw new Error('deferred resolver was not initialized');
      }
      resolvePromise(value);
    },
  };
}

describe('TelegramOwnershipReconciler', () => {
  it('reconciles a market card from authoritative market evidence', async () => {
    const job = createJob();
    const fake = createFakeDb([[job]]);
    const reconciler = createTelegramOwnershipReconciler({
      db: fake.db,
      resolvers: {
        market_card: createMarketCardOwnershipResolver({
          getMarket: async (marketId) =>
            marketId === 'market-1'
              ? { group_id: -1001, card_tg_message_id: 321 }
              : null,
        }),
      },
      workerId: WORKER_ID,
      batchSize: 10,
      leaseMs: 500,
      maxAttempts: 2,
    });

    await expect(reconciler.runOnce(new AbortController().signal)).resolves.toBe(1);

    expect(fake.calls.reconciled).toEqual([
      { jobId: job.id, workerId: WORKER_ID, messageId: 321 },
    ]);
    expect(fake.calls.manualReview).toEqual([]);
    expect(fake.calls.leases).toEqual([[WORKER_ID, 10, 500]]);
  });

  it('retries an unknown kind before manual review without a Telegram capability', async () => {
    const firstAttempt = createJob({ domainKind: 'future_kind', reconcileAttempts: 1 });
    const finalAttempt = createJob({ domainKind: 'future_kind', reconcileAttempts: 2 });
    const fake = createFakeDb([[firstAttempt], [finalAttempt]]);
    const reconciler = createTelegramOwnershipReconciler({
      db: fake.db,
      resolvers: {},
      workerId: WORKER_ID,
      batchSize: 10,
      leaseMs: 500,
      maxAttempts: 2,
    });

    await expect(reconciler.runOnce(new AbortController().signal)).resolves.toBe(1);
    expect(fake.calls.manualReview).toEqual([]);
    await expect(reconciler.runOnce(new AbortController().signal)).resolves.toBe(1);

    expect(fake.calls.reconciled).toEqual([]);
    expect(fake.calls.manualReview).toEqual([
      { jobId: finalAttempt.id, workerId: WORKER_ID, errorCode: 'unknown_domain_kind' },
    ]);
    expect(Object.keys(fake.db)).not.toContain('send');
  });

  it('moves missing authoritative evidence to manual review at the configured cap', async () => {
    const job = createJob({ reconcileAttempts: 2 });
    const fake = createFakeDb([[job]]);
    const reconciler = createTelegramOwnershipReconciler({
      db: fake.db,
      resolvers: { market_card: async () => null },
      workerId: WORKER_ID,
      batchSize: 10,
      leaseMs: 500,
      maxAttempts: 2,
    });

    await expect(reconciler.runOnce(new AbortController().signal)).resolves.toBe(1);

    expect(fake.calls.reconciled).toEqual([]);
    expect(fake.calls.manualReview).toEqual([
      { jobId: job.id, workerId: WORKER_ID, errorCode: 'authoritative_id_missing' },
    ]);
  });

  it('isolates one resolver error so another leased job can reconcile', async () => {
    const failedJob = createJob({ id: '00000000-0000-4000-8000-000000000102', domainId: 'broken' });
    const resolvedJob = createJob({ id: '00000000-0000-4000-8000-000000000103', domainId: 'resolved' });
    const fake = createFakeDb([[failedJob, resolvedJob]]);
    const reconciler = createTelegramOwnershipReconciler({
      db: fake.db,
      resolvers: {
        market_card: async (marketId) => {
          if (marketId === 'broken') {
            throw new Error('resolver unavailable');
          }
          return 654;
        },
      },
      workerId: WORKER_ID,
      batchSize: 10,
      leaseMs: 500,
      maxAttempts: 2,
    });

    await expect(reconciler.runOnce(new AbortController().signal)).resolves.toBe(2);

    expect(fake.calls.reconciled).toEqual([
      { jobId: resolvedJob.id, workerId: WORKER_ID, messageId: 654 },
    ]);
    expect(fake.calls.manualReview).toEqual([]);
  });

  it('stops leasing and drains only the in-flight reconciliation', async () => {
    const started = createDeferred<void>();
    const resolved = createDeferred<number | null>();
    const fake = createFakeDb([[createJob()]]);
    const reconciler = createTelegramOwnershipReconciler({
      db: fake.db,
      resolvers: {
        market_card: async () => {
          started.resolve();
          return resolved.promise;
        },
      },
      workerId: WORKER_ID,
      batchSize: 10,
      leaseMs: 500,
      maxAttempts: 2,
    });

    const activeRun = reconciler.runOnce(new AbortController().signal);
    await started.promise;
    reconciler.stopLeasing();

    expect(reconciler.unfinished()).toBe(1);
    await expect(reconciler.runOnce(new AbortController().signal)).resolves.toBe(0);

    let drained = false;
    const drain = reconciler.drain(new AbortController().signal).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolved.resolve(777);
    await activeRun;
    await drain;

    expect(reconciler.unfinished()).toBe(0);
    expect(fake.calls.reconciled).toEqual([
      { jobId: '00000000-0000-4000-8000-000000000101', workerId: WORKER_ID, messageId: 777 },
    ]);
    expect(fake.calls.heartbeats.at(-1)).toEqual({
      workerKind: 'telegram_ownership_reconciler',
      workerId: WORKER_ID,
      stopping: true,
    });
  });
});
