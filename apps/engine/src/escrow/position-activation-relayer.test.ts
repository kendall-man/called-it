import type { EscrowRelayerJobRow } from '@calledit/db';
import {
  bytesToHex,
  deriveMarketPda,
  derivePositionLotPda,
  deriveProtocolConfigPda,
  deriveUserPositionPda,
  materializeInstruction,
  type MarketAccount,
  type PositionLotAccount,
  type ProtocolConfigAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import { base58Decode } from '@calledit/solana';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createEscrowJobIdempotencyKey } from './job-state.js';
import {
  createEscrowPositionActivationFinalityVerifier,
  createEscrowPositionActivationTransactionBuilder,
  type EscrowPositionActivationRelayerChain,
} from './position-activation-relayer.js';

const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const BLOCKHASH = '11111111111111111111111111111111';

function setup(overrides: {
  readonly market?: Partial<MarketAccount>;
  readonly position?: Partial<UserPositionAccount>;
  readonly lot?: Partial<PositionLotAccount>;
  readonly config?: Partial<ProtocolConfigAccount>;
  readonly observedGenesisHash?: string;
  readonly job?: Partial<EscrowRelayerJobRow>;
} = {}) {
  const programId = Keypair.generate().publicKey.toBase58();
  const sponsor = Keypair.generate();
  const owner = Keypair.generate().publicKey.toBase58();
  const marketPda = deriveMarketPda(programId, MARKET_ID).address;
  const positionPda = deriveUserPositionPda(programId, marketPda, owner).address;
  const lotPda = derivePositionLotPda(programId, marketPda, owner, 4n).address;
  const configPda = deriveProtocolConfigPda(programId).address;
  const market: MarketAccount = {
    version: 1, bump: 1, marketUuid: MARKET_ID, fixtureId: 91n,
    claimSpecificationHash: new Uint8Array(32), displayTermsHash: new Uint8Array(32),
    oddsMessageHash: new Uint8Array(32), marketDocumentHash: Uint8Array.from({ length: 32 }, () => 0xab),
    quoteTimestamp: 1_699_999_000n, probabilityPpm: 500_000, ratioMilli: 1_500,
    asset: 'sol', tokenMint: null, feeBps: 100, state: 'open', replay: false,
    createdTimestamp: 1_699_999_000n, inPlayStartTimestamp: 1_699_999_900n,
    activationDelaySeconds: 10n, positionCutoffTimestamp: 1_700_001_000n,
    resolutionDeadline: 1_700_010_000n, oracleSetEpoch: 2n, eventEpoch: 7n,
    activeBackTotal: 0n, activeDoubtTotal: 0n, pendingBackTotal: 10_000n,
    pendingDoubtTotal: 0n, finalMatchedBackTotal: 0n, finalMatchedDoubtTotal: 0n,
    finalForfeitedTotal: 0n, settlementProcessedPositionCount: 0n,
    settlementOutcome: null, settlementEvidenceHash: null, positionCount: 1n,
    claimedPositionCount: 0n, vault: Keypair.generate().publicKey.toBase58(), vaultBump: 1,
    residualRecipient: Keypair.generate().publicKey.toBase58(),
    ...overrides.market,
  };
  const position: UserPositionAccount = {
    version: 1, bump: 1, market: marketPda, owner, side: 'back', activeAmount: 0n,
    pendingAmount: 10_000n, refundableAmount: 0n, settlementBaseEntitlement: 0n,
    settlementProcessed: false, nextLotNonce: 5n, claimed: false,
    totalPaidAmount: 10_000n, createdSlot: 10n, updatedSlot: 10n,
    ...overrides.position,
  };
  const lot: PositionLotAccount = {
    version: 1, bump: 1, market: marketPda, owner, nonce: 4n, side: 'back', amount: 10_000n,
    placedTimestamp: 1_699_999_990n, placedSlot: 10n, observedEventEpoch: 7n,
    state: 'pending', activationTimestamp: 1_700_000_010n, invalidationEvidenceHash: null,
    ...overrides.lot,
  };
  const config: ProtocolConfigAccount = {
    version: 1, bump: 1, paused: false,
    configAuthority: Keypair.generate().publicKey.toBase58(),
    pauseAuthority: Keypair.generate().publicKey.toBase58(),
    marketCreationAuthority: Keypair.generate().publicKey.toBase58(),
    feedOperatorAuthority: Keypair.generate().publicKey.toBase58(),
    oracleSet: Keypair.generate().publicKey.toBase58(),
    relayerFeePayer: sponsor.publicKey.toBase58(), clusterGenesisHash: base58Decode(GENESIS_HASH),
    canonicalUsdcMint: Keypair.generate().publicKey.toBase58(),
    residualRecipient: market.residualRecipient, minimumSolPosition: 1n, maximumSolPosition: 1_000_000n,
    minimumUsdcPosition: 1n, maximumUsdcPosition: 1_000_000n,
    maximumMarketDurationSeconds: 86_400n, maximumResolutionDelaySeconds: 3_600n,
    allowedTokenProgram: Keypair.generate().publicKey.toBase58(),
    ...overrides.config,
  };
  const payload = {
    schemaVersion: 1, operation: 'activate_position_lot', cluster: 'devnet',
    genesisHash: GENESIS_HASH, programId, custodyVersion: 1,
    relayerFeePayer: sponsor.publicKey.toBase58(), marketId: MARKET_ID, marketPda,
    documentHashHex: 'ab'.repeat(32), positionPda, positionLotPda: lotPda,
    owner, lotNonce: '4', expectedEventEpoch: '7', activationTimestamp: '1700000010',
  } as const;
  const job: EscrowRelayerJobRow = {
    id: 'activation-1', kind: 'position_activation',
    idempotencyKey: createEscrowJobIdempotencyKey({
      kind: 'position_activation', programId, marketPda, owner, lotNonce: 4n, eventEpoch: 7n,
    }), state: 'leased',
    cluster: 'devnet', programId, custodyMode: 'escrow', custodyVersion: 1,
    marketId: MARKET_ID, ownerPubkey: owner, payload,
    attempts: 1, maxAttempts: 12, leaseDurationMs: 30_000,
    dueAt: '2023-11-14T22:13:30.000Z', leaseOwner: 'worker-1', leaseToken: 'lease-1',
    leaseExpiresAt: '2023-11-14T22:14:00.000Z', expectedSignature: null,
    rawTransactionBase64: null, transactionMessageHashHex: null,
    lastValidBlockHeight: null, errorCode: null,
    createdAt: '2023-11-14T22:13:20.000Z', updatedAt: '2023-11-14T22:13:20.000Z',
    ...overrides.job,
  };
  const wrap = <T>(address: string, value: T) => ({ address, ownerProgramId: programId, lamports: 1n, value });
  const chain: EscrowPositionActivationRelayerChain = {
    async genesisHash() { return overrides.observedGenesisHash ?? GENESIS_HASH; },
    async unixTimestamp() { return 1_700_000_011n; },
    async latestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 123n }; },
    async config(address) { return address === configPda ? wrap(configPda, config) : null; },
    async market(address) { return address === marketPda ? wrap(marketPda, market) : null; },
    async position(address) { return address === positionPda ? wrap(positionPda, position) : null; },
    async lot(address) { return address === lotPda ? wrap(lotPda, lot) : null; },
  };
  const deployment = {
    cluster: 'devnet' as const, genesisHash: GENESIS_HASH, programId,
    custodyVersion: 1, relayerFeePayer: sponsor.publicKey.toBase58(),
  };
  const db = {
    async getMarketLink() {
      return {
        ok: true as const, found: true as const, marketId: MARKET_ID,
        custodyMode: 'escrow' as const, custodyVersion: 1, cluster: 'devnet' as const,
        genesisHash: GENESIS_HASH, programId, marketPda, vaultPda: market.vault,
        asset: market.asset, mintPubkey: market.tokenMint, documentHashHex: 'ab'.repeat(32),
        oracleEpoch: market.oracleSetEpoch, eventEpoch: 7n, ratioMilli: BigInt(market.ratioMilli),
        chainState: 'open' as const, commitment: 'finalized' as const, projectionStale: false,
      };
    },
  };
  return { programId, sponsor, owner, marketPda, positionPda, lotPda, market, position, lot, job, chain, deployment, db };
}

describe('escrow position activation relayer', () => {
  it('builds an exact activation instruction with the sponsor as the only signer and fee payer', async () => {
    const fixture = setup();
    const built = await createEscrowPositionActivationTransactionBuilder(fixture).build(fixture.job);
    const transaction = VersionedTransaction.deserialize(Buffer.from(built.rawTransactionBase64, 'base64'));

    expect(transaction.message.header.numRequiredSignatures).toBe(1);
    expect(transaction.message.staticAccountKeys[0]?.toBase58()).toBe(fixture.sponsor.publicKey.toBase58());
    expect(transaction.signatures).toHaveLength(1);
    expect(transaction.signatures[0]?.some((byte) => byte !== 0)).toBe(true);
    expect(transaction.message.compiledInstructions).toHaveLength(1);
    expect(transaction.message.staticAccountKeys[
      transaction.message.compiledInstructions[0]?.programIdIndex ?? -1
    ]?.toBase58()).toBe(fixture.programId);
    expect(bytesToHex(transaction.message.compiledInstructions[0]?.data ?? new Uint8Array())).toBe(bytesToHex(
      materializeInstruction({
        kind: 'activate_position_lot', marketUuid: MARKET_ID,
        owner: fixture.owner, lotNonce: 4n, expectedEventEpoch: 7n,
      }, { programId: new PublicKey(fixture.programId) }).data,
    ));
    expect(built.lastValidBlockHeight).toBe(123n);
  });

  it.each([
    [{ market: { eventEpoch: 8n } }, 'stale_epoch'],
    [{ lot: { state: 'voided' as const, invalidationEvidenceHash: new Uint8Array(32) } }, 'lot_invalidated'],
    [{ observedGenesisHash: 'wrong-genesis' }, 'deployment_mismatch'],
    [{ config: { relayerFeePayer: Keypair.generate().publicKey.toBase58() } }, 'deployment_mismatch'],
    [{ job: { idempotencyKey: 'tampered-activation-key' } }, 'deployment_mismatch'],
  ] as const)('fails closed before signing when the bound state changed', async (overrides, code) => {
    const fixture = setup(overrides);
    await expect(createEscrowPositionActivationTransactionBuilder(fixture).build(fixture.job))
      .rejects.toMatchObject({ code });
  });

  it('waits for the chain activation timestamp instead of signing early', async () => {
    const fixture = setup();
    fixture.chain.unixTimestamp = async () => 1_700_000_009n;
    await expect(createEscrowPositionActivationTransactionBuilder(fixture).build(fixture.job))
      .rejects.toMatchObject({ code: 'activation_not_due' });
  });

  it('uses finalized lot state to make transaction replay idempotent', async () => {
    const pending = setup();
    const pendingVerifier = createEscrowPositionActivationFinalityVerifier(pending);
    await expect(pendingVerifier.confirm(pending.job, { signature: 'sig', slot: 20n })).resolves.toBe('pending');

    const active = setup({ lot: { state: 'active' }, position: { pendingAmount: 0n, activeAmount: 10_000n }, market: { pendingBackTotal: 0n, activeBackTotal: 10_000n } });
    await expect(createEscrowPositionActivationFinalityVerifier(active).confirm(
      active.job, { signature: 'sig', slot: 20n },
    )).resolves.toBe('confirmed');

    const invalidatedAfterActivation = setup({
      market: { eventEpoch: 8n, pendingBackTotal: 0n, activeBackTotal: 0n },
      position: { pendingAmount: 0n, activeAmount: 0n, refundableAmount: 10_000n },
      lot: { state: 'voided', invalidationEvidenceHash: new Uint8Array(32) },
    });
    await expect(createEscrowPositionActivationFinalityVerifier(invalidatedAfterActivation).confirm(
      invalidatedAfterActivation.job, { signature: 'sig', slot: 20n },
    )).resolves.toBe('confirmed');

    const invalidatedWithoutEpochAdvance = setup({
      lot: { state: 'voided', invalidationEvidenceHash: new Uint8Array(32) },
    });
    await expect(createEscrowPositionActivationFinalityVerifier(invalidatedWithoutEpochAdvance).confirm(
      invalidatedWithoutEpochAdvance.job, { signature: 'sig', slot: 20n },
    )).resolves.toBe('mismatch');
  });
});
