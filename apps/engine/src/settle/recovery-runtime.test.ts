import { describe, expect, it } from 'vitest';
import type { DurableProofWorker } from '../proofs/durable-proof-worker.js';
import type { DurableQueuePolicy } from './durable.js';
import type { DurableSettlementWorker } from './durable-settlement-worker.js';
import { createDurableSettlementProofRuntime } from './recovery-runtime.js';
import { MemorySettlementProofJobs } from './recovery.test-support.js';

const POLICY: DurableQueuePolicy = {
  maxAttempts: 3,
  leaseMs: 10_000,
  retryBaseMs: 1_000,
  retryMaxMs: 8_000,
  initialChainProofDelayMs: 60_000,
};

describe('durable settlement/proof runtime', () => {
  it('reports actual durable queue backlog and worker heartbeats after recovery work starts', async () => {
    // Given a pending proof job and deterministic workers
    const jobs = new MemorySettlementProofJobs();
    await jobs.enqueueJob({
      marketId: 'market-1',
      jobKind: 'proof',
      dueAtIso: new Date(1_000).toISOString(),
      nowIso: new Date(1_000).toISOString(),
      maxAttempts: POLICY.maxAttempts,
      leaseMs: POLICY.leaseMs,
      retryBaseMs: POLICY.retryBaseMs,
      retryMaxMs: POLICY.retryMaxMs,
    });
    let settlementHeartbeat: number | null = null;
    let proofHeartbeat: number | null = null;
    const settlement = {
      tick: async () => { settlementHeartbeat = 1_000; },
      heartbeatAtMs: () => settlementHeartbeat,
    } satisfies DurableSettlementWorker;
    const proof = {
      tick: async () => { proofHeartbeat = 1_000; },
      heartbeatAtMs: () => proofHeartbeat,
    } satisfies DurableProofWorker;
    const runtime = createDurableSettlementProofRuntime({
      jobs,
      settlement,
      proof,
      clock: { now: () => 1_000 },
      policy: POLICY,
      reconcileLimit: 10,
      log: silentLog,
    });

    // When one periodic recovery tick finishes
    await runtime.tick();
    const snapshot = await runtime.readinessPort('proof').snapshot(new AbortController().signal);

    // Then readiness observes the persisted queue rather than static placeholders
    expect(snapshot).toEqual({
      enabled: true,
      heartbeatAtMs: 1_000,
      backlog: 1,
      deadCount: 0,
      oldestAgeMs: 0,
    });
  });

  it('surfaces immutable dead jobs without reopening them while healthy jobs still lease', async () => {
    const jobs = new MemorySettlementProofJobs();
    await jobs.enqueueJob({
      marketId: 'poison-market',
      jobKind: 'proof',
      dueAtIso: new Date(1_000).toISOString(),
      nowIso: new Date(1_000).toISOString(),
      maxAttempts: 1,
      leaseMs: POLICY.leaseMs,
      retryBaseMs: POLICY.retryBaseMs,
      retryMaxMs: POLICY.retryMaxMs,
    });
    const poison = (await jobs.leaseJobs({
      jobKind: 'proof', workerId: 'seed', nowIso: new Date(1_000).toISOString(), limit: 1,
    }))[0];
    if (poison === undefined || poison.leaseToken === null) throw new Error('poison lease missing');
    await jobs.retryJob({
      marketId: poison.marketId,
      jobKind: poison.jobKind,
      workerId: 'seed',
      leaseToken: poison.leaseToken,
      errorCode: 'unexpected_error',
      delayMs: POLICY.retryBaseMs,
      nowIso: new Date(1_000).toISOString(),
    });
    await jobs.enqueueJob({
      marketId: 'healthy-market',
      jobKind: 'proof',
      dueAtIso: new Date(1_000).toISOString(),
      nowIso: new Date(1_000).toISOString(),
      maxAttempts: POLICY.maxAttempts,
      leaseMs: POLICY.leaseMs,
      retryBaseMs: POLICY.retryBaseMs,
      retryMaxMs: POLICY.retryMaxMs,
    });
    let proofHeartbeat: number | null = null;
    const settlement = {
      tick: async () => undefined,
      heartbeatAtMs: () => 1_000,
    } satisfies DurableSettlementWorker;
    const proof = {
      tick: async () => {
        proofHeartbeat = 1_000;
        const leased = await jobs.leaseJobs({
          jobKind: 'proof', workerId: 'healthy', nowIso: new Date(1_000).toISOString(), limit: 4,
        });
        for (const job of leased) {
          if (job.leaseToken === null) throw new Error('healthy lease missing');
          await jobs.completeJob({
            marketId: job.marketId,
            jobKind: job.jobKind,
            workerId: 'healthy',
            leaseToken: job.leaseToken,
            nowIso: new Date(1_000).toISOString(),
          });
        }
      },
      heartbeatAtMs: () => proofHeartbeat,
    } satisfies DurableProofWorker;
    const runtime = createDurableSettlementProofRuntime({
      jobs,
      settlement,
      proof,
      clock: { now: () => 1_000 },
      policy: POLICY,
      reconcileLimit: 10,
      log: silentLog,
    });

    await runtime.tick();
    const snapshot = await runtime.readinessPort('proof').snapshot(new AbortController().signal);

    expect(snapshot.deadCount).toBe(1);
    expect(jobs.job('poison-market', 'proof').status).toBe('dead');
    expect(jobs.job('healthy-market', 'proof').status).toBe('complete');
  });

  it('waits for a running recovery tick through its bounded-shutdown drain', async () => {
    // Given a recovery tick blocked in a leased settlement worker
    const jobs = new MemorySettlementProofJobs();
    let finish: () => void = () => {
      throw new Error('settlement worker did not start');
    };
    const settlement = {
      tick: async () => new Promise<void>((resolve) => { finish = resolve; }),
      heartbeatAtMs: () => 1_000,
    } satisfies DurableSettlementWorker;
    const proof = {
      tick: async () => undefined,
      heartbeatAtMs: () => 1_000,
    } satisfies DurableProofWorker;
    const runtime = createDurableSettlementProofRuntime({
      jobs,
      settlement,
      proof,
      clock: { now: () => 1_000 },
      policy: POLICY,
      reconcileLimit: 10,
      log: silentLog,
    });

    // When shutdown begins while that tick is in flight
    const tick = runtime.tick();
    await Promise.resolve();
    const drain = runtime.shutdownDrain();
    const drained = drain.drain(new AbortController().signal);

    // Then the drain advertises the running work and resolves only after it finishes
    expect(drain.unfinished()).toBe(1);
    finish();
    await Promise.all([tick, drained]);
    expect(drain.unfinished()).toBe(0);
  });
});

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
