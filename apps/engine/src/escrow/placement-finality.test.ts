import {
  derivePositionLotPda,
  deriveUserPositionPda,
  type PositionLotAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createEscrowPlacementFinalityVerifier } from './placement-finality.js';
import type { DurableEscrowRelayerJobRow } from './relayer-worker.js';

const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';

function setup() {
  const programId = Keypair.generate().publicKey.toBase58();
  const owner = Keypair.generate().publicKey.toBase58();
  const marketPda = Keypair.generate().publicKey.toBase58();
  const positionPda = deriveUserPositionPda(programId, marketPda, owner).address;
  const lotPda = derivePositionLotPda(programId, marketPda, owner, 2n).address;
  const payload = {
    operation: 'place_position', rawTransactionBase64: 'raw', expectedSignature: 'signature',
    transactionMessageHashHex: 'ab'.repeat(32), recentBlockhash: 'blockhash', lastValidBlockHeight: '10',
    feePayer: Keypair.generate().publicKey.toBase58(), ownerPubkey: owner, programId,
    canonicalUsdcMint: Keypair.generate().publicKey.toBase58(), marketId: MARKET_ID, marketPda,
    marketDocumentHashHex: 'cd'.repeat(32), side: 'back' as const, asset: 'sol' as const,
    amountAtomic: '25', expectedRatioMilli: 1_500, eventEpoch: '4', lotNonce: '2',
    expiresAt: '2000000000', genesisHash: 'genesis',
  };
  const job: DurableEscrowRelayerJobRow = {
    id: 'job-a', kind: 'position_placement', idempotencyKey: 'placement-a', state: 'leased',
    cluster: 'devnet', programId, custodyMode: 'escrow', custodyVersion: 1,
    marketId: MARKET_ID, ownerPubkey: owner, payload, attempts: 1, maxAttempts: 8,
    leaseDurationMs: 60_000, dueAt: '2026-07-15T00:00:00.000Z', leaseOwner: 'worker-a',
    leaseToken: 'lease-a', leaseExpiresAt: '2026-07-15T00:01:00.000Z', expectedSignature: 'signature',
    rawTransactionBase64: 'raw', transactionMessageHashHex: 'ab'.repeat(32), lastValidBlockHeight: 10n,
    errorCode: null, createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
  };
  const position: UserPositionAccount = {
    version: 1, bump: 1, market: marketPda, owner, side: 'back', activeAmount: 0n,
    pendingAmount: 25n, refundableAmount: 0n, settlementBaseEntitlement: 0n,
    settlementProcessed: false, nextLotNonce: 3n, claimed: false, totalPaidAmount: 25n,
    createdSlot: 1n, updatedSlot: 2n,
  };
  const lot: PositionLotAccount = {
    version: 1, bump: 1, market: marketPda, owner, nonce: 2n, side: 'back', amount: 25n,
    placedTimestamp: 1n, placedSlot: 2n, observedEventEpoch: 4n, state: 'pending',
    activationTimestamp: 5n, invalidationEvidenceHash: null,
  };
  return { programId, positionPda, lotPda, job, position, lot };
}

describe('placement finalized effect verifier', () => {
  it('requires the exact derived lot after a restart', async () => {
    const fixture = setup();
    const decoded = <T>(address: string, value: T) => ({
      address, ownerProgramId: fixture.programId, lamports: 1n, value,
    });
    const verifier = createEscrowPlacementFinalityVerifier({
      chain: {
        async position(address) { return decoded(address, fixture.position); },
        async lot(address) { return decoded(address, fixture.lot); },
      },
    });
    await expect(verifier.confirm(fixture.job, { signature: 'signature', slot: 2n }))
      .resolves.toBe('confirmed');

    const tampered = createEscrowPlacementFinalityVerifier({
      chain: {
        async position(address) { return decoded(address, fixture.position); },
        async lot(address) { return decoded(address, { ...fixture.lot, amount: 26n }); },
      },
    });
    await expect(tampered.confirm(fixture.job, { signature: 'signature', slot: 2n }))
      .resolves.toBe('mismatch');
  });
});
