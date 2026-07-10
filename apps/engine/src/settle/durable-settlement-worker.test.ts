import { describe, expect, it } from 'vitest';
import { createDurableSettlementWorker } from './durable-settlement-worker.js';
import type { DurableQueuePolicy } from './durable.js';
import type { RecoveredSettlementFact } from './recovery-types.js';
import { MemorySettlementProofJobs } from './recovery.test-support.js';

const POLICY: DurableQueuePolicy = {
  maxAttempts: 3,
  leaseMs: 10_000,
  retryBaseMs: 1_000,
  retryMaxMs: 8_000,
  initialChainProofDelayMs: 60_000,
};

function fact(marketId: string): RecoveredSettlementFact {
  return {
    marketId,
    fixtureId: 99,
    outcome: 'claim_won',
    tier: 'chain_proven',
    decidingSeq: 5,
    comparator: 'gte',
    threshold: 2,
    statKey: 1,
  };
}

async function enqueueSettlement(jobs: MemorySettlementProofJobs, marketId: string): Promise<void> {
  await jobs.recordTerminalSettlement({
    marketId,
    outcome: 'claim_won',
    decidingSeq: 5,
    evidenceSeqs: [5],
    tier: 'chain_proven',
    nowIso: new Date(1_000).toISOString(),
    maxAttempts: POLICY.maxAttempts,
    leaseMs: POLICY.leaseMs,
    retryBaseMs: POLICY.retryBaseMs,
    retryMaxMs: POLICY.retryMaxMs,
  });
}

describe('durable settlement worker', () => {
  it('applies money, enqueues proof, marks delivery, then completes in that order', async () => {
    // Given one leased settlement and a receipt that has actually landed
    const jobs = new MemorySettlementProofJobs();
    await enqueueSettlement(jobs, 'market-1');
    const trace: string[] = [];
    const worker = createDurableSettlementWorker({
      jobs,
      facts: { find: async () => fact('market-1') },
      effects: { apply: async () => { trace.push('effects'); } },
      receipts: { deliver: async () => { trace.push('receipt'); return 'delivered'; } },
      clock: { now: () => 1_000 },
      policy: POLICY,
      workerId: 'settler-a',
      leaseLimit: 4,
      log: silentLog,
    });

    // When the worker drains its durable lease
    await worker.tick();

    // Then proof is independent of the post marker and all terminal effects precede completion
    expect(trace).toEqual(['effects', 'receipt']);
    expect(jobs.job('market-1', 'proof').status).toBe('pending');
    expect(jobs.posted.has('market-1')).toBe(true);
    expect(jobs.job('market-1', 'settlement').status).toBe('complete');
    expect(jobs.trace.indexOf('posted:market-1')).toBeLessThan(
      jobs.trace.indexOf('complete:settlement:market-1'),
    );
  });

  it('keeps the proof job after an uncertain chat post and retries only settlement delivery', async () => {
    // Given a settlement whose Telegram owner has not confirmed the post
    const jobs = new MemorySettlementProofJobs();
    await enqueueSettlement(jobs, 'market-1');
    const worker = createDurableSettlementWorker({
      jobs,
      facts: { find: async () => fact('market-1') },
      effects: { apply: async () => undefined },
      receipts: { deliver: async () => 'pending' },
      clock: { now: () => 1_000 },
      policy: POLICY,
      workerId: 'settler-a',
      leaseLimit: 4,
      log: silentLog,
    });

    // When delivery remains uncertain
    await worker.tick();

    // Then settlement is retryable while proof remains durably queued
    expect(jobs.posted.has('market-1')).toBe(false);
    expect(jobs.job('market-1', 'proof').status).toBe('pending');
    expect(jobs.trace).toContain('retry:settlement:market-1');
  });

  it('continues past a poison settlement lease to complete healthy work', async () => {
    // Given one effect that fails and one independent recoverable settlement
    const jobs = new MemorySettlementProofJobs();
    await enqueueSettlement(jobs, 'poison');
    await enqueueSettlement(jobs, 'healthy');
    const worker = createDurableSettlementWorker({
      jobs,
      facts: { find: async (marketId) => fact(marketId) },
      effects: {
        apply: async (marketId) => {
          if (marketId === 'poison') throw new Error('database outage');
        },
      },
      receipts: { deliver: async () => 'delivered' },
      clock: { now: () => 1_000 },
      policy: POLICY,
      workerId: 'settler-a',
      leaseLimit: 4,
      log: silentLog,
    });

    // When a single tick leases both jobs
    await worker.tick();

    // Then the poison is retried without starving the healthy market
    expect(jobs.trace).toContain('retry:settlement:poison');
    expect(jobs.job('healthy', 'settlement').status).toBe('complete');
  });
});

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
