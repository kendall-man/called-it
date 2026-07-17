import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { PgResult } from './errors.js';
import {
  settlementProofJobsDbFromClient,
  type SettlementProofJobsDbClient,
} from './settlement-proof-jobs.js';

const MARKET_ID = '00000000-0000-4000-8000-000000000010';
const LEASE_TOKEN = '00000000-0000-4000-8000-000000000011';
const NOW = '2026-07-11T12:00:00.000Z';
const LATER = '2026-07-11T12:00:30.000Z';

type RpcCall = Readonly<{ fn: string; args: Readonly<Record<string, unknown>> }>;

class FakeSettlementProofClient implements SettlementProofJobsDbClient {
  readonly calls: RpcCall[] = [];
  response: PgResult<unknown> = { data: null, error: { message: 'missing fake response' } };

  rpc(fn: string, args: Record<string, unknown>): Promise<PgResult<unknown>> {
    this.calls.push({ fn, args });
    return Promise.resolve(this.response);
  }
}

function makeDb(response: PgResult<unknown>) {
  const client = new FakeSettlementProofClient();
  client.response = response;
  return { client, db: settlementProofJobsDbFromClient(client) };
}

function job(status: 'pending' | 'leased' | 'retry_wait' | 'complete' | 'dead'): Record<string, unknown> {
  const lease = status === 'pending'
    ? { lease_owner: null, lease_token: null, leased_at: null, lease_expires_at: null }
    : { lease_owner: 'worker-a', lease_token: LEASE_TOKEN, leased_at: NOW, lease_expires_at: LATER };
  const terminal = status === 'complete'
    ? { completed_at: LATER, dead_at: null, last_error_code: null }
    : status === 'dead'
      ? { completed_at: null, dead_at: LATER, last_error_code: 'proof_verify_failed' }
      : status === 'retry_wait'
        ? { completed_at: null, dead_at: null, last_error_code: 'proof_verify_pending' }
        : { completed_at: null, dead_at: null, last_error_code: null };
  return {
    market_id: MARKET_ID,
    job_kind: 'proof',
    status,
    attempts: status === 'pending' ? 0 : 1,
    max_attempts: 8,
    lease_ms: 30_000,
    retry_base_ms: 500,
    retry_max_ms: 30_000,
    due_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...lease,
    ...terminal,
  };
}

describe('settlementProofJobsDbFromClient', () => {
  it('maps every RPC argument with an injected clock', async () => {
    const { client, db } = makeDb({
      data: { ok: true, duplicate: false, market_id: MARKET_ID, job_status: 'pending' },
      error: null,
    });
    await db.recordTerminalSettlement({
      marketId: MARKET_ID,
      outcome: 'claim_won',
      decidingSeq: 10,
      evidenceSeqs: [8, 9, 10],
      tier: 'chain_proven',
      nowIso: NOW,
      maxAttempts: 8,
      leaseMs: 30_000,
      retryBaseMs: 500,
      retryMaxMs: 30_000,
    });
    expect(client.calls).toEqual([{
      fn: 'settlement_record_terminal',
      args: {
        p_market_id: MARKET_ID,
        p_outcome: 'claim_won',
        p_deciding_seq: 10,
        p_evidence_seqs: [8, 9, 10],
        p_tier: 'chain_proven',
        p_now: NOW,
        p_max_attempts: 8,
        p_lease_ms: 30_000,
        p_retry_base_ms: 500,
        p_retry_max_ms: 30_000,
      },
    }]);

    client.response = { data: [job('leased')], error: null };
    await db.leaseJobs({ jobKind: 'proof', workerId: 'worker-a', nowIso: NOW, limit: 2 });
    expect(client.calls[1]).toEqual({
      fn: 'settlement_proof_lease',
      args: { p_job_kind: 'proof', p_worker_id: 'worker-a', p_now: NOW, p_limit: 2 },
    });

    client.response = { data: { ok: true, status: 'retry_wait', duplicate: false }, error: null };
    await db.retryJob({
      marketId: MARKET_ID,
      jobKind: 'proof',
      workerId: 'worker-a',
      leaseToken: LEASE_TOKEN,
      errorCode: 'proof_verify_pending',
      delayMs: 500,
      nowIso: NOW,
    });
    expect(client.calls[2]).toEqual({
      fn: 'settlement_proof_retry',
      args: {
        p_market_id: MARKET_ID,
        p_job_kind: 'proof',
        p_worker_id: 'worker-a',
        p_lease_token: LEASE_TOKEN,
        p_error_code: 'proof_verify_pending',
        p_delay_ms: 500,
        p_now: NOW,
      },
    });

    client.response = { data: { ready_count: 0, oldest_ready_age_ms: null, active_lease_count: 0, retry_wait_count: 0, expired_lease_count: 0, dead_count: 0 }, error: null };
    await db.backlog('proof', NOW);
    expect(client.calls[3]).toEqual({
      fn: 'settlement_proof_backlog',
      args: { p_job_kind: 'proof', p_now: NOW },
    });
  });

  it('maps the remaining write, inspection, and reconciliation RPCs without deriving a clock', async () => {
    const { client, db } = makeDb({ data: { ok: true, duplicate: false, posted_at: NOW }, error: null });
    await db.markSettlementPosted(MARKET_ID, NOW);
    client.response = { data: { ok: true, duplicate: false, market_id: MARKET_ID, kind: 'stat', status: 'pending', verified_at: null }, error: null };
    await db.recordProofState({
      marketId: MARKET_ID,
      kind: 'stat',
      statKey: 1,
      seq: 10,
      merkleProof: { nodes: ['proof'] },
      validateStatTx: null,
      explorerUrl: null,
      status: 'pending',
      nowIso: NOW,
    });
    client.response = { data: { ok: true, created: true, job: job('pending') }, error: null };
    await db.enqueueJob({
      marketId: MARKET_ID,
      jobKind: 'proof',
      dueAtIso: LATER,
      nowIso: NOW,
      maxAttempts: 8,
      leaseMs: 30_000,
      retryBaseMs: 500,
      retryMaxMs: 30_000,
    });
    client.response = { data: { ok: true, status: 'complete', duplicate: false }, error: null };
    await db.completeJob({ marketId: MARKET_ID, jobKind: 'proof', workerId: 'worker-a', leaseToken: LEASE_TOKEN, nowIso: NOW });
    client.response = { data: { ok: true, status: 'dead', duplicate: false }, error: null };
    await db.deadLetterJob({
      marketId: MARKET_ID,
      jobKind: 'proof',
      workerId: 'worker-a',
      leaseToken: LEASE_TOKEN,
      errorCode: 'proof_verify_failed',
      nowIso: NOW,
    });
    client.response = {
      data: [{
        market_id: MARKET_ID,
        settlement_job_missing: false,
        settlement_row_missing: false,
        wager_marker_missing: true,
        proof_job_missing: false,
        proof_terminal_missing: true,
        chat_post_missing: true,
        settlement_terminal_conflict: false,
        proof_terminal_conflict: false,
      }],
      error: null,
    };
    await db.terminalGaps(100);
    client.response = {
      data: [{
        market_id: MARKET_ID,
        reason_codes: ['proof_job_missing'],
        settlement_job_created: false,
        proof_job_created: true,
      }],
      error: null,
    };
    await db.reconcileTerminalJobs({
      nowIso: NOW,
      limit: 100,
      maxAttempts: 8,
      leaseMs: 30_000,
      retryBaseMs: 500,
      retryMaxMs: 30_000,
      initialChainProofDelayMs: 60_000,
    });

    expect(client.calls).toEqual([
      { fn: 'settlement_mark_posted', args: { p_market_id: MARKET_ID, p_now: NOW } },
      {
        fn: 'proof_record_state',
        args: {
          p_market_id: MARKET_ID,
          p_kind: 'stat',
          p_stat_key: 1,
          p_seq: 10,
          p_merkle_proof: { nodes: ['proof'] },
          p_validate_stat_tx: null,
          p_explorer_url: null,
          p_status: 'pending',
          p_now: NOW,
        },
      },
      {
        fn: 'settlement_proof_enqueue',
        args: {
          p_market_id: MARKET_ID,
          p_job_kind: 'proof',
          p_due_at: LATER,
          p_now: NOW,
          p_max_attempts: 8,
          p_lease_ms: 30_000,
          p_retry_base_ms: 500,
          p_retry_max_ms: 30_000,
        },
      },
      {
        fn: 'settlement_proof_complete',
        args: { p_market_id: MARKET_ID, p_job_kind: 'proof', p_worker_id: 'worker-a', p_lease_token: LEASE_TOKEN, p_now: NOW },
      },
      {
        fn: 'settlement_proof_dead_letter',
        args: {
          p_market_id: MARKET_ID,
          p_job_kind: 'proof',
          p_worker_id: 'worker-a',
          p_lease_token: LEASE_TOKEN,
          p_error_code: 'proof_verify_failed',
          p_now: NOW,
        },
      },
      { fn: 'settlement_terminal_gaps', args: { p_limit: 100 } },
      {
        fn: 'settlement_reconcile_terminal_jobs',
        args: {
          p_now: NOW,
          p_limit: 100,
          p_max_attempts: 8,
          p_lease_ms: 30_000,
          p_retry_base_ms: 500,
          p_retry_max_ms: 30_000,
          p_initial_chain_proof_delay_ms: 60_000,
        },
      },
    ]);
  });

  it('parses every legal durable job state and transition result', async () => {
    for (const status of ['pending', 'leased', 'retry_wait', 'complete', 'dead'] as const) {
      const { db } = makeDb({ data: { ok: true, created: true, job: job(status) }, error: null });
      const result = await db.enqueueJob({
        marketId: MARKET_ID,
        jobKind: 'proof',
        dueAtIso: NOW,
        nowIso: NOW,
        maxAttempts: 8,
        leaseMs: 30_000,
        retryBaseMs: 500,
        retryMaxMs: 30_000,
      });
      expect(result).toMatchObject({ ok: true, job: { status } });
    }

    const transition = makeDb({ data: { ok: true, status: 'complete', duplicate: true }, error: null });
    await expect(transition.db.completeJob({
      marketId: MARKET_ID,
      jobKind: 'proof',
      workerId: 'worker-a',
      leaseToken: LEASE_TOKEN,
      nowIso: NOW,
    })).resolves.toEqual({ ok: true, status: 'complete', duplicate: true });

    const refusal = makeDb({ data: { ok: false, code: 'proof_terminal_missing' }, error: null });
    await expect(refusal.db.deadLetterJob({
      marketId: MARKET_ID,
      jobKind: 'proof',
      workerId: 'worker-a',
      leaseToken: LEASE_TOKEN,
      errorCode: 'proof_verify_failed',
      nowIso: NOW,
    })).resolves.toEqual({ ok: false, code: 'proof_terminal_missing' });
  });

  it('rejects unknown state, unsafe counters, malformed timestamps, and impossible lease shapes', async () => {
    const malformedJobs = [
      { ...job('pending'), status: 'unknown' },
      { ...job('pending'), job_kind: 'unknown' },
      { ...job('pending'), attempts: Number.MAX_SAFE_INTEGER + 1 },
      { ...job('pending'), created_at: 'not-a-timestamp' },
      { ...job('leased'), lease_token: null },
      { ...job('complete'), completed_at: null },
      { ...job('dead'), dead_at: null },
    ];
    for (const malformed of malformedJobs) {
      const { db } = makeDb({ data: { ok: true, created: true, job: malformed }, error: null });
      await expect(db.enqueueJob({
        marketId: MARKET_ID,
        jobKind: 'proof',
        dueAtIso: NOW,
        nowIso: NOW,
        maxAttempts: 8,
        leaseMs: 30_000,
        retryBaseMs: 500,
        retryMaxMs: 30_000,
      })).rejects.toThrow('malformed RPC payload');
    }

    const badCode = makeDb({ data: { ok: false, code: 'unknown_code' }, error: null });
    await expect(badCode.db.markSettlementPosted(MARKET_ID, NOW)).rejects.toThrow('malformed RPC payload');

    const badBacklog = makeDb({
      data: { ready_count: 1, oldest_ready_age_ms: null, active_lease_count: 0, retry_wait_count: 0, expired_lease_count: 0, dead_count: 0 },
      error: null,
    });
    await expect(badBacklog.db.backlog('proof', NOW)).rejects.toThrow('malformed RPC payload');

    const unsafeInput = makeDb({ data: { ok: true, duplicate: false, market_id: MARKET_ID, job_status: 'pending' }, error: null });
    expect(() => unsafeInput.db.recordTerminalSettlement({
      marketId: MARKET_ID,
      outcome: 'claim_won',
      decidingSeq: Number.MAX_SAFE_INTEGER + 1,
      evidenceSeqs: [],
      tier: 'chain_proven',
      nowIso: NOW,
      maxAttempts: 8,
      leaseMs: 30_000,
      retryBaseMs: 500,
      retryMaxMs: 30_000,
    })).toThrow('unsafe integer');
    expect(unsafeInput.client.calls).toHaveLength(0);
  });

  it('maps zero and nonzero backlog snapshots without an ambient clock', async () => {
    const zero = makeDb({
      data: { ready_count: 0, oldest_ready_age_ms: null, active_lease_count: 0, retry_wait_count: 0, expired_lease_count: 0, dead_count: 0 },
      error: null,
    });
    await expect(zero.db.backlog('settlement', NOW)).resolves.toEqual({
      readyCount: 0,
      oldestReadyAgeMs: null,
      activeLeaseCount: 0,
      retryWaitCount: 0,
      expiredLeaseCount: 0,
      deadCount: 0,
    });

    const nonzero = makeDb({
      data: { ready_count: 2, oldest_ready_age_ms: 60_000, active_lease_count: 1, retry_wait_count: 3, expired_lease_count: 1, dead_count: 4 },
      error: null,
    });
    await expect(nonzero.db.backlog('proof', NOW)).resolves.toMatchObject({ readyCount: 2, oldestReadyAgeMs: 60_000 });

    const source = await readFile(new URL('./settlement-proof-jobs.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Date\.now\(|new Date\(/);
  });
});
