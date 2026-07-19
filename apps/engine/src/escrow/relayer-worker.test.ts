import type { EscrowDb } from '@calledit/db';
import { buildSponsoredPositionTransaction, deriveMarketPda } from '@calledit/escrow-sdk';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { sponsorTransaction } from './transaction-signatures.js';
import {
  createEscrowRelayerWorker,
  type DurableEscrowRelayerJobRow,
  type EscrowRelayerWorkerDatabase,
  type EscrowRelayChain,
} from './relayer-worker.js';

const NOW = '2026-07-15T00:00:00.000Z';
const LATER = '2026-07-15T00:00:10.000Z';
const BLOCKHASH = '11111111111111111111111111111111';
const GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';

function signedPlacementPayload() {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const program = Keypair.generate();
  const mint = Keypair.generate();
  const built = buildSponsoredPositionTransaction({
    programId: program.publicKey,
    relayerFeePayer: feePayer.publicKey,
    userWallet: owner.publicKey,
    canonicalUsdcMint: mint.publicKey,
    marketUuid: MARKET_ID,
    marketDocumentHash: Uint8Array.from({ length: 32 }, () => 0xab),
    side: 'back',
    amount: 25n,
    asset: 'sol',
    expectedRatioMilli: 1_500,
    expectedEventEpoch: 4n,
    expectedLotNonce: 0n,
    expiresAt: 2_000_000_000n,
    genesisHash: GENESIS_HASH,
    recentBlockhash: BLOCKHASH,
    lastValidBlockHeight: 900n,
  });
  const transaction = built.transaction;
  const sponsored = sponsorTransaction(transaction, feePayer);
  transaction.sign([owner]);
  return {
    rawTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
    expectedSignature: sponsored.expectedSignature,
    transactionMessageHashHex: sponsored.messageHashHex,
    recentBlockhash: BLOCKHASH,
    lastValidBlockHeight: '900',
    operation: 'place_position',
    feePayer: feePayer.publicKey.toBase58(),
    ownerPubkey: owner.publicKey.toBase58(),
    programId: program.publicKey.toBase58(),
    canonicalUsdcMint: mint.publicKey.toBase58(),
    marketId: MARKET_ID,
    marketPda: deriveMarketPda(program.publicKey, MARKET_ID).address,
    marketDocumentHashHex: 'ab'.repeat(32),
    side: 'back',
    asset: 'sol',
    amountAtomic: '25',
    expectedRatioMilli: 1_500,
    lotNonce: '0',
    eventEpoch: '4',
    expiresAt: '2000000000',
    genesisHash: GENESIS_HASH,
  };
}

function leasedJob(payload: ReturnType<typeof signedPlacementPayload>, raw: string | null): DurableEscrowRelayerJobRow {
  return {
    id: '123e4567-e89b-12d3-a456-426614174111', kind: 'position_placement',
    idempotencyKey: 'placement-a', state: 'leased', cluster: 'devnet', programId: payload.programId,
    custodyMode: 'escrow', custodyVersion: 1, marketId: payload.marketId, ownerPubkey: payload.ownerPubkey,
    payload, attempts: 1, maxAttempts: 8, leaseDurationMs: 60_000, dueAt: NOW,
    leaseOwner: 'worker-a', leaseToken: '123e4567-e89b-12d3-a456-426614174222', leaseExpiresAt: LATER,
    expectedSignature: raw === null ? null : payload.expectedSignature,
    rawTransactionBase64: raw,
    transactionMessageHashHex: raw === null ? null : payload.transactionMessageHashHex,
    lastValidBlockHeight: raw === null ? null : 900n,
    errorCode: null, createdAt: NOW, updatedAt: NOW,
  };
}

function setup(
  job: DurableEscrowRelayerJobRow,
  chainOverrides: Partial<EscrowRelayChain> = {},
  finalityVerifiers?: Parameters<typeof createEscrowRelayerWorker>[0]['finalityVerifiers'],
  placementReady = true,
  builders?: Parameters<typeof createEscrowRelayerWorker>[0]['builders'],
  additionalJobs: readonly DurableEscrowRelayerJobRow[] = [],
) {
  const calls: string[] = [];
  const broadcasts: string[] = [];
  const retryErrors: string[] = [];
  let readinessChecks = 0;
  const payloadSignature = job.payload.expectedSignature;
  if (typeof payloadSignature !== 'string') throw new Error('expected placement signature');
  const db: EscrowRelayerWorkerDatabase = {
      async leaseRelayerJobs() { calls.push('lease'); return [job, ...additionalJobs]; },
      async recordRelayerSignedTransaction() { calls.push('record_signed'); return { ok: true, created: false, jobId: job.id }; },
      async markRelayerSubmitted() { calls.push('submitted'); return { ok: true, duplicate: false, state: 'submitted' }; },
      async retryRelayerJob(input) {
        calls.push(`retry:${input.confirmationUnknown}`);
        retryErrors.push(input.errorCode);
        return { ok: true, duplicate: false, state: input.confirmationUnknown ? 'unknown' : 'retry_wait' };
      },
      async completeRelayerJob() { calls.push('complete'); return { ok: true, duplicate: false, state: 'complete' }; },
      async deadLetterRelayerJob(input) { calls.push(`dead:${input.errorCode}`); return { ok: true, duplicate: false, state: 'dead' }; },
    };
  const chain: EscrowRelayChain = {
    async broadcast(raw) { broadcasts.push(raw); return payloadSignature; },
    async signatureState() { return { kind: 'absent' }; },
    async genesisHash() { return GENESIS_HASH; },
    async blockHeight() { return 800n; },
    async isBlockhashValid() { return true; },
    ...chainOverrides,
  };
  const worker = createEscrowRelayerWorker({
    db, chain, workerId: 'worker-a', retryAt: () => LATER, finalityVerifiers, builders,
    positionPlacementReadiness: async () => {
      readinessChecks += 1;
      return placementReady
        ? { status: 'ready', reasons: [] }
        : { status: 'not_ready', reasons: ['program_paused'] };
    },
  });
  return { worker, calls, broadcasts, retryErrors, readinessChecks: () => readinessChecks };
}

describe('sponsored escrow relayer recovery', () => {
  it('completes a server-built job that landed before its signed bytes were persisted', async () => {
    const payload = signedPlacementPayload();
    const job = { ...leasedJob(payload, null), kind: 'market_initialization' as const };
    const fixture = setup(job, {}, {
      market_initialization: { confirm: async () => 'confirmed' },
    }, true, {
      market_initialization: { build: async () => { throw new Error('must not rebuild'); } },
    });

    await expect(fixture.worker.runOnce(NOW, 1)).resolves.toEqual([{
      kind: 'complete', jobId: job.id, signature: '',
    }]);
    expect(fixture.calls).toEqual(['lease', 'complete']);
  });

  it('persists fully signed user bytes and schedules prompt exact-byte reconciliation', async () => {
    // Given a newly leased durable placement payload
    const payload = signedPlacementPayload();
    const fixture = setup(leasedJob(payload, null));

    // When the relay worker processes it
    const result = await fixture.worker.runOnce(NOW, 1);

    // Then bytes are persisted before the exact transaction is submitted, and
    // the signed row uses the existing short retry boundary instead of the
    // database's generic submitted quarantine.
    expect(result).toEqual([{ kind: 'retrying', jobId: expect.any(String), signature: payload.expectedSignature }]);
    expect(fixture.readinessChecks()).toBe(1);
    expect(fixture.calls).toEqual(['lease', 'record_signed']);
    expect(fixture.broadcasts).toEqual([payload.rawTransactionBase64]);
  });

  it('retains signed bytes without first broadcast while placement readiness is blocked', async () => {
    const payload = signedPlacementPayload();
    const fixture = setup(leasedJob(payload, null), {}, undefined, false);

    const result = await fixture.worker.runOnce(NOW, 1);

    expect(result).toEqual([{
      kind: 'retrying', jobId: expect.any(String), signature: payload.expectedSignature,
    }]);
    expect(fixture.readinessChecks()).toBe(1);
    expect(fixture.broadcasts).toHaveLength(0);
    expect(fixture.calls).toEqual(['lease', 'record_signed']);
    expect(fixture.retryErrors).toEqual([]);
  });

  it('schedules prompt exact-byte reconciliation after an ambiguous first broadcast', async () => {
    const payload = signedPlacementPayload();
    const fixture = setup(leasedJob(payload, null), {
      broadcast: async () => { throw new Error('rpc unavailable after send'); },
    });

    await expect(fixture.worker.runOnce(NOW, 1)).resolves.toEqual([{
      kind: 'retrying', jobId: expect.any(String), signature: payload.expectedSignature,
    }]);
    expect(fixture.calls).toEqual(['lease', 'record_signed']);
    expect(fixture.broadcasts).toHaveLength(0);
  });

  it('retains the generic submitted quarantine for server-built jobs', async () => {
    const payload = signedPlacementPayload();
    const job = { ...leasedJob(payload, null), kind: 'market_initialization' as const };
    const fixture = setup(job, {}, undefined, true, {
      market_initialization: {
        async build() {
          return {
            rawTransactionBase64: payload.rawTransactionBase64,
            expectedSignature: payload.expectedSignature,
            transactionMessageHashHex: payload.transactionMessageHashHex,
            lastValidBlockHeight: BigInt(payload.lastValidBlockHeight),
          };
        },
      },
    });

    await expect(fixture.worker.runOnce(NOW, 1)).resolves.toEqual([{
      kind: 'submitted', jobId: job.id, signature: payload.expectedSignature,
    }]);
    expect(fixture.calls).toEqual(['lease', 'record_signed', 'submitted']);
  });

  it('rebroadcasts identical persisted bytes after restart', async () => {
    // Given a restarted lease whose full-history lookup is absent but blockhash is live
    const payload = signedPlacementPayload();
    const fixture = setup(leasedJob(payload, payload.rawTransactionBase64));

    // When recovery runs
    await fixture.worker.runOnce(NOW, 1);

    // Then no transaction is rebuilt and unknown confirmation remains retryable
    expect(fixture.readinessChecks()).toBe(1);
    expect(fixture.broadcasts).toEqual([payload.rawTransactionBase64]);
    expect(fixture.calls).toEqual(['lease', 'retry:true']);
  });

  it('does not rebroadcast an absent persisted placement while readiness is blocked', async () => {
    const payload = signedPlacementPayload();
    const fixture = setup(
      leasedJob(payload, payload.rawTransactionBase64), {}, undefined, false,
    );

    const result = await fixture.worker.runOnce(NOW, 1);

    expect(result).toEqual([{
      kind: 'retrying', jobId: expect.any(String), signature: payload.expectedSignature,
    }]);
    expect(fixture.readinessChecks()).toBe(1);
    expect(fixture.broadcasts).toHaveLength(0);
    expect(fixture.calls).toEqual(['lease', 'retry:true']);
  });

  it('terminally rejects an expired user signature after full-history absence', async () => {
    // Given an expired placement whose signature never landed
    const payload = signedPlacementPayload();
    const fixture = setup(leasedJob(payload, payload.rawTransactionBase64), {
      isBlockhashValid: async () => false,
      blockHeight: async () => 901n,
    });

    // When recovery runs
    await fixture.worker.runOnce(NOW, 1);

    // Then the user signature is preserved and never server-replaced
    expect(fixture.broadcasts).toHaveLength(0);
    expect(fixture.calls).toEqual(['lease', 'dead:user_signature_expired']);
  });

  it('terminally rejects durable terms that no longer match the user-signed message', async () => {
    // Given a valid user signature paired with a substituted durable amount
    const payload = { ...signedPlacementPayload(), amountAtomic: '26' };
    const fixture = setup(leasedJob(payload, null));

    // When first-broadcast verification reconstructs the SDK terms
    const result = await fixture.worker.runOnce(NOW, 1);

    // Then the corrupted job is dead-lettered without touching the network
    expect(result).toEqual([{
      kind: 'terminal', jobId: expect.any(String), errorCode: 'invalid_user_transaction',
    }]);
    expect(fixture.broadcasts).toHaveLength(0);
    expect(fixture.calls).toEqual(['lease', 'dead:invalid_user_transaction']);
  });

  it('waits for the finalized economic effect before completing a job', async () => {
    const payload = signedPlacementPayload();
    const fixture = setup(leasedJob(payload, payload.rawTransactionBase64), {
      signatureState: async () => ({ kind: 'finalized', slot: 42n }),
    }, {
      position_placement: { confirm: async () => 'pending' },
    });

    await expect(fixture.worker.runOnce(NOW, 1)).resolves.toMatchObject([{ kind: 'retrying' }]);
    expect(fixture.calls).toEqual(['lease', 'retry:true']);
  });

  it('processes leased jobs sequentially to bound public RPC pressure', async () => {
    const payload = signedPlacementPayload();
    const first = leasedJob(payload, payload.rawTransactionBase64);
    const second = {
      ...first,
      id: '123e4567-e89b-12d3-a456-426614174333',
      idempotencyKey: 'placement-b',
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const fixture = setup(first, {
      async signatureState() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { kind: 'finalized', slot: 42n };
      },
    }, undefined, true, undefined, [second]);

    await expect(fixture.worker.runOnce(NOW, 2)).resolves.toHaveLength(2);
    expect(maxInFlight).toBe(1);
    expect(fixture.calls).toEqual(['lease', 'complete', 'complete']);
  });

  it('still completes finalized placements while readiness is blocked', async () => {
    const payload = signedPlacementPayload();
    const fixture = setup(leasedJob(payload, payload.rawTransactionBase64), {
      signatureState: async () => ({ kind: 'finalized', slot: 42n }),
    }, undefined, false);

    await expect(fixture.worker.runOnce(NOW, 1)).resolves.toEqual([{
      kind: 'complete', jobId: expect.any(String), signature: payload.expectedSignature,
    }]);
    expect(fixture.readinessChecks()).toBe(0);
    expect(fixture.calls).toEqual(['lease', 'complete']);
  });

  it('still dead-letters failed placements while readiness is blocked', async () => {
    const payload = signedPlacementPayload();
    const fixture = setup(leasedJob(payload, payload.rawTransactionBase64), {
      signatureState: async () => ({ kind: 'failed', errorCode: 'instruction_failed' }),
    }, undefined, false);

    await expect(fixture.worker.runOnce(NOW, 1)).resolves.toEqual([{
      kind: 'terminal', jobId: expect.any(String), errorCode: 'instruction_failed',
    }]);
    expect(fixture.readinessChecks()).toBe(0);
    expect(fixture.calls).toEqual(['lease', 'dead:instruction_failed']);
  });

  it('keeps claim and refund rebroadcasts independent of placement readiness', async () => {
    const payload = signedPlacementPayload();
    const placementJob = leasedJob(payload, payload.rawTransactionBase64);
    const fixture = setup({ ...placementJob, kind: 'auto_claim' }, {}, undefined, false);

    await expect(fixture.worker.runOnce(NOW, 1)).resolves.toMatchObject([{ kind: 'retrying' }]);
    expect(fixture.readinessChecks()).toBe(0);
    expect(fixture.broadcasts).toEqual([payload.rawTransactionBase64]);
    expect(fixture.calls).toEqual(['lease', 'retry:true']);
  });
});
