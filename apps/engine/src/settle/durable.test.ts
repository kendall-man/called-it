import {
  settlementProofJobsDbFromClient,
  type SettlementProofJobsDbClient,
} from '@calledit/db';
import { describe, expect, it } from 'vitest';
import { createSettlementJournal, type DurableQueuePolicy } from './durable.js';
import { MemorySettlementProofJobs } from './recovery.test-support.js';

const POLICY: DurableQueuePolicy = {
  maxAttempts: 3,
  leaseMs: 10_000,
  retryBaseMs: 1_000,
  retryMaxMs: 8_000,
  initialChainProofDelayMs: 60_000,
};

describe('durable terminal settlement journal', () => {
  it('records the immutable terminal fact and settlement recovery job through one facade call', async () => {
    // Given a deterministic clock and an empty durable job store
    const jobs = new MemorySettlementProofJobs();
    const journal = createSettlementJournal({ jobs, clock: { now: () => 1_000 }, policy: POLICY });

    // When the settler records a terminal outcome
    const result = await journal.recordTerminal({
      marketId: 'market-1',
      outcome: 'claim_won',
      decidingSeq: 44,
      evidenceSeqs: [41, 44],
      tier: 'chain_proven',
    });

    // Then the terminal fact and settlement job exist without a second engine write
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('terminal settlement unexpectedly rejected');
    expect(result.duplicate).toBe(false);
    expect(jobs.trace).toEqual(['terminal:market-1']);
    expect(jobs.job('market-1', 'settlement').status).toBe('pending');
  });

  it('uses the Task 10 terminal RPC so fact and settlement-job creation cannot split', async () => {
    // Given the actual facade over a narrow Supabase RPC client seam
    const calls: Array<{ readonly fn: string; readonly args: Record<string, unknown> }> = [];
    const client = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return {
          data: {
            ok: true,
            duplicate: false,
            market_id: '11111111-1111-1111-1111-111111111111',
            job_status: 'pending',
          },
          error: null,
        };
      },
    } satisfies SettlementProofJobsDbClient;
    const journal = createSettlementJournal({
      jobs: settlementProofJobsDbFromClient(client),
      clock: { now: () => 1_000 },
      policy: POLICY,
    });

    // When the settler records a durable terminal fact
    await journal.recordTerminal({
      marketId: '11111111-1111-1111-1111-111111111111',
      outcome: 'claim_lost',
      decidingSeq: 8,
      evidenceSeqs: [8],
      tier: 'oracle_resolved',
    });

    // Then engine performs exactly the atomic RPC, never separate fact/job writes
    expect(calls).toEqual([
      {
        fn: 'settlement_record_terminal',
        args: {
          p_market_id: '11111111-1111-1111-1111-111111111111',
          p_outcome: 'claim_lost',
          p_deciding_seq: 8,
          p_evidence_seqs: [8],
          p_tier: 'oracle_resolved',
          p_now: '1970-01-01T00:00:01.000Z',
          p_max_attempts: 3,
          p_lease_ms: 10_000,
          p_retry_base_ms: 1_000,
          p_retry_max_ms: 8_000,
        },
      },
    ]);
  });
});
