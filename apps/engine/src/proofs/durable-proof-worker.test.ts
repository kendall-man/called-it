import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDurableProofWorker } from './durable-proof-worker.js';
import type { DurableQueuePolicy } from '../settle/durable.js';
import type { RecoveredSettlementFact } from '../settle/recovery-types.js';
import { MemorySettlementProofJobs } from '../settle/recovery.test-support.js';

const POLICY: DurableQueuePolicy = {
  maxAttempts: 3,
  leaseMs: 10_000,
  retryBaseMs: 1_000,
  retryMaxMs: 8_000,
  initialChainProofDelayMs: 60_000,
};
const LEAF = '11'.repeat(32);
const SIBLING = '22'.repeat(32);
const ROOT = sha256Hex(LEAF, SIBLING);
const PROOF = {
  summary: {
    updateStats: { minTimestamp: 1_752_000_000_000 },
    eventsSubTreeRoot: LEAF,
  },
  mainTreeProof: [{ hash: SIBLING, isRightSibling: true }],
};

function sha256Hex(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part, 'hex');
  return hash.digest('hex');
}

function fact(): RecoveredSettlementFact {
  return {
    marketId: 'market-1',
    fixtureId: 99,
    outcome: 'claim_won',
    tier: 'chain_proven',
    decidingSeq: 5,
    comparator: 'gte',
    threshold: 2,
    statKey: 1,
  };
}

async function enqueueProof(jobs: MemorySettlementProofJobs, policy = POLICY): Promise<void> {
  await jobs.enqueueJob({
    marketId: 'market-1',
    jobKind: 'proof',
    dueAtIso: new Date(1_000).toISOString(),
    nowIso: new Date(1_000).toISOString(),
    maxAttempts: policy.maxAttempts,
    leaseMs: policy.leaseMs,
    retryBaseMs: policy.retryBaseMs,
    retryMaxMs: policy.retryMaxMs,
  });
}

describe('durable proof worker', () => {
  it('writes verified only after the main-tree path matches an expected root', async () => {
    // Given a durable proof job, a root-verified TxLINE proof, and a successful submitter
    const jobs = new MemorySettlementProofJobs();
    await enqueueProof(jobs);
    const submissions: number[] = [];
    const worker = createDurableProofWorker({
      jobs,
      facts: { find: async () => fact() },
      tx: { fetchStatProof: async () => PROOF },
      submitter: {
        submit: async () => {
          submissions.push(1);
          return { ok: true, txSig: 'proof-tx' };
        },
      },
      roots: { rootsFor: async () => [ROOT] },
      clock: { now: () => 1_000 },
      policy: POLICY,
      workerId: 'proof-a',
      leaseLimit: 4,
      log: silentLog,
    });

    // When the proof lease runs
    await worker.tick();

    // Then the persisted proof is verified and its durable job completes
    expect(submissions).toEqual([1]);
    expect(jobs.proofs.get('market-1')?.status).toBe('verified');
    expect(jobs.job('market-1', 'proof').status).toBe('complete');
  });

  it('records unavailable and never submits when the proof misses expected roots', async () => {
    // Given a self-consistent proof whose main tree lands on no published root
    const jobs = new MemorySettlementProofJobs();
    await enqueueProof(jobs);
    let submitted = false;
    const worker = createDurableProofWorker({
      jobs,
      facts: { find: async () => fact() },
      tx: { fetchStatProof: async () => PROOF },
      submitter: { submit: async () => { submitted = true; return { ok: true, txSig: 'wrong' }; } },
      roots: { rootsFor: async () => ['33'.repeat(32)] },
      clock: { now: () => 1_000 },
      policy: POLICY,
      workerId: 'proof-a',
      leaseLimit: 4,
      log: silentLog,
    });

    // When the root mismatch is discovered
    await worker.tick();

    // Then the terminal fallback is honest and no chain submission occurs
    expect(submitted).toBe(false);
    expect(jobs.proofs.get('market-1')?.status).toBe('unavailable');
    expect(jobs.job('market-1', 'proof').status).toBe('complete');
  });

  it('dead-letters only after recording failed when expected roots stay unavailable', async () => {
    // Given a one-attempt proof job and an unavailable root source
    const policy = { ...POLICY, maxAttempts: 1 };
    const jobs = new MemorySettlementProofJobs();
    await enqueueProof(jobs, policy);
    const worker = createDurableProofWorker({
      jobs,
      facts: { find: async () => fact() },
      tx: { fetchStatProof: async () => PROOF },
      submitter: { submit: async () => ({ ok: true, txSig: 'unused' }) },
      roots: { rootsFor: async () => null },
      clock: { now: () => 1_000 },
      policy,
      workerId: 'proof-a',
      leaseLimit: 4,
      log: silentLog,
    });

    // When the sole attempt cannot verify a real root
    await worker.tick();

    // Then failed proof state is durable before the job reaches the dead letter
    expect(jobs.proofs.get('market-1')?.status).toBe('failed');
    expect(jobs.job('market-1', 'proof').status).toBe('dead');
    expect(jobs.trace.indexOf('dead:proof:market-1')).toBeGreaterThan(
      jobs.trace.indexOf('lease:proof:market-1'),
    );
  });
});

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
