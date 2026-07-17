import { describe, expect, it } from 'vitest';
import {
  createEscrowJob,
  createEscrowJobIdempotencyKey,
  transitionEscrowJob,
  type EscrowRelayerJob,
} from './job-state.js';

const INIT_IDENTITY = {
  kind: 'market_initialization',
  programId: 'program-a',
  marketPda: 'market-a',
} as const;

function newJob(maxAttempts = 3): EscrowRelayerJob {
  return createEscrowJob(INIT_IDENTITY, maxAttempts);
}

function requireTransition(
  job: EscrowRelayerJob,
  command: Parameters<typeof transitionEscrowJob>[1],
): EscrowRelayerJob {
  const result = transitionEscrowJob(job, command);
  if (!result.ok) throw new Error(`transition rejected: ${result.code}`);
  return result.job;
}

function preparedJob(): EscrowRelayerJob {
  let job = requireTransition(newJob(), {
    type: 'lease',
    workerId: 'worker-a',
    leaseToken: 'lease-a',
    nowMs: 1_000,
  });
  job = requireTransition(job, {
    type: 'prepare_transaction',
    rawTransactionBase64: 'AQIDBA==',
    expectedSignature: 'signature-a',
    lastValidBlockHeight: 50n,
  });
  return job;
}

describe('escrow durable jobs', () => {
  it('builds deterministic, kind-specific idempotency keys', () => {
    const first = createEscrowJobIdempotencyKey(INIT_IDENTITY);
    const duplicate = createEscrowJobIdempotencyKey({ ...INIT_IDENTITY });
    const otherMarket = createEscrowJobIdempotencyKey({
      ...INIT_IDENTITY,
      marketPda: 'market-b',
    });
    const otherEpoch = createEscrowJobIdempotencyKey({
      kind: 'freeze',
      programId: 'program-a',
      marketPda: 'market-a',
      eventEpoch: 2n,
    });

    expect(first).toBe(duplicate);
    expect(first).not.toBe(otherMarket);
    expect(first).not.toBe(otherEpoch);
    expect(first).toMatch(/^escrow:v1:market_initialization:/);
  });

  it('includes anti-snipe lot identity in activation keys', () => {
    const first = createEscrowJobIdempotencyKey({
      kind: 'position_activation',
      programId: 'program-a',
      marketPda: 'market-a',
      owner: 'owner-a',
      lotNonce: 4n,
      eventEpoch: 9n,
    });
    const nextEpoch = createEscrowJobIdempotencyKey({
      kind: 'position_activation',
      programId: 'program-a',
      marketPda: 'market-a',
      owner: 'owner-a',
      lotNonce: 4n,
      eventEpoch: 10n,
    });

    expect(first).not.toBe(nextEpoch);
  });

  it('persists signed bytes and requires the expected signature on broadcast', () => {
    const prepared = preparedJob();

    expect(prepared.transaction).toEqual({
      rawTransactionBase64: 'AQIDBA==',
      expectedSignature: 'signature-a',
      lastValidBlockHeight: 50n,
    });
    expect(
      transitionEscrowJob(prepared, {
        type: 'record_broadcast',
        observedSignature: 'signature-b',
      }),
    ).toEqual({ ok: false, code: 'signature_mismatch' });
  });

  it('rebroadcasts identical bytes while the blockhash is live', () => {
    const prepared = preparedJob();
    const retrying = requireTransition(prepared, {
      type: 'schedule_rebroadcast',
      currentBlockHeight: 50n,
      nextAttemptAtMs: 2_000,
      errorCode: 'rpc_timeout',
    });

    expect(retrying.status).toBe('retry_wait');
    expect(retrying.transaction).toBe(prepared.transaction);
    const leased = requireTransition(retrying, {
      type: 'lease',
      workerId: 'worker-b',
      leaseToken: 'lease-b',
      nowMs: 2_000,
    });
    expect(leased.transaction).toBe(prepared.transaction);
  });

  it('does not re-sign before expiry or without a full-history absence check', () => {
    const prepared = preparedJob();

    expect(
      transitionEscrowJob(prepared, {
        type: 'schedule_resign',
        currentBlockHeight: 50n,
        fullHistoryChecked: true,
        transactionLanded: false,
        nextAttemptAtMs: 2_000,
        errorCode: 'blockhash_expired',
      }),
    ).toEqual({ ok: false, code: 'blockhash_still_live' });
    expect(
      transitionEscrowJob(prepared, {
        type: 'schedule_resign',
        currentBlockHeight: 51n,
        fullHistoryChecked: false,
        transactionLanded: false,
        nextAttemptAtMs: 2_000,
        errorCode: 'blockhash_expired',
      }),
    ).toEqual({ ok: false, code: 'full_history_check_required' });
  });

  it('permits re-signing only after expiry and confirmed full-history absence', () => {
    const prepared = preparedJob();
    const retrying = requireTransition(prepared, {
      type: 'schedule_resign',
      currentBlockHeight: 51n,
      fullHistoryChecked: true,
      transactionLanded: false,
      nextAttemptAtMs: 2_000,
      errorCode: 'blockhash_expired',
    });

    expect(retrying.status).toBe('retry_wait');
    expect(retrying.transaction).toBeNull();
  });

  it('treats matching repeated confirmations as idempotent', () => {
    const prepared = preparedJob();
    const confirmed = requireTransition(prepared, {
      type: 'record_confirmation',
      signature: 'signature-a',
      slot: 42n,
    });
    const repeated = transitionEscrowJob(confirmed, {
      type: 'record_confirmation',
      signature: 'signature-a',
      slot: 42n,
    });

    expect(repeated).toEqual({ ok: true, changed: false, job: confirmed });
    expect(
      transitionEscrowJob(confirmed, {
        type: 'record_confirmation',
        signature: 'signature-b',
        slot: 42n,
      }),
    ).toEqual({ ok: false, code: 'signature_mismatch' });
  });

  it('does not lease beyond the configured attempt limit', () => {
    let job = newJob(1);
    job = requireTransition(job, {
      type: 'lease',
      workerId: 'worker-a',
      leaseToken: 'lease-a',
      nowMs: 1_000,
    });
    job = requireTransition(job, {
      type: 'schedule_retry_without_transaction',
      nextAttemptAtMs: 2_000,
      errorCode: 'dependency_unavailable',
    });

    expect(
      transitionEscrowJob(job, {
        type: 'lease',
        workerId: 'worker-b',
        leaseToken: 'lease-b',
        nowMs: 2_000,
      }),
    ).toEqual({ ok: false, code: 'max_attempts_exhausted' });
  });
});
