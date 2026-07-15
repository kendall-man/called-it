import assert from 'node:assert/strict';

import { buildUnsignedV0Transaction } from '../../packages/escrow-sdk/src/index.js';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { describe, it } from '../../apps/engine/node_modules/vitest/dist/index.js';

import { sponsorTransaction } from '../../apps/engine/src/escrow/transaction-signatures.js';
import type {
  DurableEscrowRelayerJobRow,
  EscrowRelayChain,
  EscrowRelayerFinalityVerifier,
  EscrowRelayerPreparedTransaction,
  EscrowRelayerTransactionBuilder,
  EscrowRelayerWorkerDatabase,
} from '../../apps/engine/src/escrow/relayer-worker.js';
import {
  DevnetRelayerRecoveryE2eError,
  assertLiveExecutionEnabled,
  exerciseDurableRelayerLifecycle,
  parseCliArgs,
  parseRecoveryRequest,
} from './devnet-relayer-recovery-e2e.js';

const STARTED_AT = '2026-07-15T00:00:00.000Z';
const FIRST_BLOCKHASH = '11111111111111111111111111111111';
const REPLACEMENT_BLOCKHASH = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
  .publicKey.toBase58();
const JOB_ID = '123e4567-e89b-12d3-a456-426614174111';
const PROGRAM_ID = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 3)).publicKey.toBase58();
const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';

class MemoryRelayerDatabase implements EscrowRelayerWorkerDatabase {
  private row: DurableEscrowRelayerJobRow = {
    id: JOB_ID,
    kind: 'timeout_monitoring',
    idempotencyKey: 'recovery-e2e',
    state: 'pending',
    cluster: 'devnet',
    programId: PROGRAM_ID,
    custodyMode: 'escrow',
    custodyVersion: 1,
    marketId: MARKET_ID,
    ownerPubkey: null,
    payload: {},
    attempts: 0,
    maxAttempts: 12,
    leaseDurationMs: 60_000,
    dueAt: STARTED_AT,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    expectedSignature: null,
    rawTransactionBase64: null,
    transactionMessageHashHex: null,
    lastValidBlockHeight: null,
    errorCode: null,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
  };

  snapshot(): DurableEscrowRelayerJobRow {
    return this.row;
  }

  async leaseRelayerJobs(input: Parameters<EscrowRelayerWorkerDatabase['leaseRelayerJobs']>[0]) {
    if (this.row.state === 'complete' || this.row.state === 'dead') return [];
    this.row = {
      ...this.row,
      state: 'leased',
      attempts: this.row.attempts + 1,
      leaseOwner: input.workerId,
      leaseToken: `123e4567-e89b-12d3-a456-${String(this.row.attempts + 1).padStart(12, '0')}`,
      leaseExpiresAt: new Date(Date.parse(input.nowIso) + 60_000).toISOString(),
      updatedAt: input.nowIso,
    };
    return [this.row];
  }

  async recordRelayerSignedTransaction(
    input: Parameters<EscrowRelayerWorkerDatabase['recordRelayerSignedTransaction']>[0],
  ) {
    this.row = {
      ...this.row,
      rawTransactionBase64: input.rawTransactionBase64,
      expectedSignature: input.expectedSignature,
      transactionMessageHashHex: input.transactionMessageHashHex,
      lastValidBlockHeight: input.lastValidBlockHeight,
      updatedAt: input.nowIso,
    };
    return { ok: true as const, created: false, jobId: this.row.id };
  }

  async markRelayerSubmitted(
    input: Parameters<EscrowRelayerWorkerDatabase['markRelayerSubmitted']>[0],
  ) {
    this.row = { ...this.row, state: 'submitted', leaseOwner: null, leaseToken: null };
    return { ok: true as const, duplicate: false, state: 'submitted' as const };
  }

  async retryRelayerJob(input: Parameters<EscrowRelayerWorkerDatabase['retryRelayerJob']>[0]) {
    this.row = {
      ...this.row,
      state: input.confirmationUnknown ? 'unknown' : 'retry_wait',
      dueAt: input.retryAtIso,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: input.errorCode,
      ...(input.confirmationUnknown ? {} : {
        rawTransactionBase64: null,
        expectedSignature: null,
        transactionMessageHashHex: null,
        lastValidBlockHeight: null,
      }),
      updatedAt: input.nowIso,
    };
    return {
      ok: true as const,
      duplicate: false,
      state: input.confirmationUnknown ? 'unknown' as const : 'retry_wait' as const,
    };
  }

  async completeRelayerJob(
    input: Parameters<EscrowRelayerWorkerDatabase['completeRelayerJob']>[0],
  ) {
    this.row = { ...this.row, state: 'complete', leaseOwner: null, leaseToken: null };
    return { ok: true as const, duplicate: false, state: 'complete' as const };
  }

  async deadLetterRelayerJob(
    input: Parameters<EscrowRelayerWorkerDatabase['deadLetterRelayerJob']>[0],
  ) {
    this.row = {
      ...this.row,
      state: 'dead',
      leaseOwner: null,
      leaseToken: null,
      errorCode: input.errorCode,
    };
    return { ok: true as const, duplicate: false, state: 'dead' as const };
  }
}

interface FixtureOptions {
  readonly oldSignatureLands?: boolean;
  readonly blockHeight?: bigint;
  readonly replacementState?: 'absent' | 'finalized';
  readonly finalityEffect?: 'confirmed' | 'pending' | 'mismatch';
}

function fixture(options: FixtureOptions = {}) {
  const payer = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 7));
  const prepared: EscrowRelayerPreparedTransaction[] = [];
  const builder: EscrowRelayerTransactionBuilder = {
    async build() {
      const index = prepared.length;
      const recentBlockhash = index === 0 ? FIRST_BLOCKHASH : REPLACEMENT_BLOCKHASH;
      const transaction = buildUnsignedV0Transaction({
        feePayer: payer.publicKey,
        recentBlockhash,
        instructions: [SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: payer.publicKey,
          lamports: 0,
        })],
      });
      const signed = sponsorTransaction(transaction, payer);
      const value = {
        rawTransactionBase64: signed.rawTransactionBase64,
        expectedSignature: signed.expectedSignature,
        transactionMessageHashHex: signed.messageHashHex,
        lastValidBlockHeight: index === 0 ? 100n : 200n,
      };
      prepared.push(value);
      return value;
    },
  };
  let actualBroadcasts = 0;
  let blockhashChecks = 0;
  const chain: EscrowRelayChain = {
    async broadcast() {
      actualBroadcasts += 1;
      const replacement = prepared[1];
      if (replacement === undefined) throw new Error('replacement was not built');
      return replacement.expectedSignature;
    },
    async signatureState(signature) {
      const first = prepared[0];
      const replacement = prepared[1];
      if (first !== undefined && signature === first.expectedSignature) {
        return options.oldSignatureLands
          ? { kind: 'finalized', slot: 40n }
          : { kind: 'absent' };
      }
      if (replacement !== undefined && signature === replacement.expectedSignature && actualBroadcasts === 1) {
        return options.replacementState === 'absent'
          ? { kind: 'absent' }
          : { kind: 'finalized', slot: 42n };
      }
      return { kind: 'absent' };
    },
    async genesisHash() { return 'devnet'; },
    async blockHeight() { return options.blockHeight ?? 101n; },
    async isBlockhashValid() {
      blockhashChecks += 1;
      return blockhashChecks === 1;
    },
  };
  const db = new MemoryRelayerDatabase();
  const finalityVerifier: EscrowRelayerFinalityVerifier = {
    async confirm() { return options.finalityEffect ?? 'confirmed'; },
  };
  return {
    db,
    chain,
    builder,
    finalityVerifier,
    prepared,
    actualBroadcasts: () => actualBroadcasts,
    effect: {
      async snapshot() {
        return sha256Text(actualBroadcasts === 0 ? 'before' : 'after');
      },
    },
  };
}

function sha256Text(value: string): string {
  return Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64);
}

async function runFixture(value: ReturnType<typeof fixture>, maxPolls = 3) {
  return exerciseDurableRelayerLifecycle({
    db: value.db,
    chain: value.chain,
    builder: value.builder,
    finalityVerifier: value.finalityVerifier,
    effect: value.effect,
    jobId: JOB_ID,
    startedAt: STARTED_AT,
    sleep: async () => undefined,
    pollIntervalMs: 0,
    maxPolls,
  });
}

describe('devnet durable relayer recovery E2E harness', () => {
  it('uses the production worker to exercise persistence, restart, unknown, expiry, re-sign, and exactly-once finality', async () => {
    const value = fixture();

    const evidence = await runFixture(value);

    assert.equal(value.prepared.length, 2);
    assert.equal(value.actualBroadcasts(), 1);
    assert.equal(value.db.snapshot().state, 'complete');
    assert.equal(evidence.actualNetworkBroadcasts, 1);
    assert.notEqual(evidence.firstSignature, evidence.replacementSignature);
    assert.equal(evidence.effectBeforeSha256, evidence.effectBeforeReplacementSha256);
    assert.notEqual(evidence.effectAfterSha256, evidence.effectBeforeSha256);
    assert.deepEqual(evidence.databaseEvents, [
      'lease',
      'record_signed',
      'retry:broadcast_unknown',
      'lease',
      'retry:confirmation_unknown',
      'lease',
      'retry:expired_not_landed',
      'lease',
      'record_signed',
      'submitted',
      'lease',
      'complete',
      'lease',
    ]);
  });

  it('fails closed instead of re-signing before height proves expiry', async () => {
    const value = fixture({ blockHeight: 100n });

    await assert.rejects(runFixture(value, 2), /timed out waiting for the persisted blockhash to expire/);
    assert.equal(value.prepared.length, 1);
    assert.equal(value.actualBroadcasts(), 0);
  });

  it('fails closed during restart if full history reports that the old signature landed', async () => {
    const value = fixture({ oldSignatureLands: true });

    await assert.rejects(runFixture(value), /restart did not rebroadcast the exact persisted bytes/);
    assert.equal(value.prepared.length, 1);
    assert.equal(value.actualBroadcasts(), 0);
  });

  for (const finalityEffect of ['pending', 'mismatch'] as const) {
    it(`does not complete when the production finality contract reports ${finalityEffect}`, async () => {
      const value = fixture({ finalityEffect });

      await assert.rejects(
        runFixture(value),
        /finalized signature did not verify the expected on-chain effect/,
      );
      assert.equal(value.actualBroadcasts(), 1);
      assert.equal(value.db.snapshot().state, finalityEffect === 'mismatch' ? 'dead' : 'unknown');
    });
  }

  it('times out without completing while replacement confirmation remains unknown', async () => {
    const value = fixture({ replacementState: 'absent' });

    await assert.rejects(runFixture(value, 2), /timed out waiting for replacement transaction finality/);
    assert.equal(value.actualBroadcasts(), 1);
    assert.equal(value.db.snapshot().state, 'submitted');
  });

  it('defaults to dry-run and requires both exact live acknowledgements', () => {
    assert.equal(parseCliArgs(['--manifest', 'release.json', '--request', 'request.json']).execute, false);
    assert.throws(() => assertLiveExecutionEnabled({}), DevnetRelayerRecoveryE2eError);
    assert.throws(() => assertLiveExecutionEnabled({
      ESCROW_RELAYER_RECOVERY_ENABLE_DEVNET_WRITES: 'I_UNDERSTAND_THIS_WRITES_DEVNET',
    }), /dedicated idle database/);
    assert.doesNotThrow(() => assertLiveExecutionEnabled({
      ESCROW_RELAYER_RECOVERY_ENABLE_DEVNET_WRITES: 'I_UNDERSTAND_THIS_WRITES_DEVNET',
      ESCROW_RELAYER_RECOVERY_DEDICATED_DB: 'I_UNDERSTAND_THIS_DATABASE_MUST_BE_IDLE',
    }));
    assert.throws(() => parseCliArgs([
      '--manifest', 'release.json', '--request', 'request.json', '--execute',
    ]), /execute mode requires --out/);
  });

  it('parses recovery requests through the engine request contract and rejects unsupported operations', () => {
    const marketPda = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 8)).publicKey.toBase58();
    const owner = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 9)).publicKey.toBase58();
    assert.deepEqual(parseRecoveryRequest({
      operation: 'close_position_lots',
      marketPda,
      owner,
      lotNonces: ['3', '2'],
    }), { operation: 'close_position_lots', marketPda, owner, lotNonces: [3n, 2n] });
    assert.throws(() => parseRecoveryRequest({ operation: 'mainnet_send', marketPda }), /unsupported/);
  });
});
