import type { EscrowDb } from '@calledit/db';
import {
  deriveMarketPda,
  derivePositionLotPda,
  deriveUserPositionPda,
  type MarketAccount,
  type PositionLotAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  createEscrowPositionActivationService,
  type EscrowPositionActivationChain,
  type EscrowPositionActivationDatabase,
} from './position-activation-service.js';

const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const NOW_ISO = '2023-11-14T22:13:20.000Z';

function setup(overrides: {
  readonly market?: Partial<MarketAccount>;
  readonly position?: Partial<UserPositionAccount>;
  readonly lot?: Partial<PositionLotAccount>;
  readonly genesisHash?: string;
} = {}) {
  const programId = Keypair.generate().publicKey.toBase58();
  const owner = Keypair.generate().publicKey.toBase58();
  const sponsor = Keypair.generate().publicKey.toBase58();
  const marketPda = deriveMarketPda(programId, MARKET_ID).address;
  const positionPda = deriveUserPositionPda(programId, marketPda, owner).address;
  const lotPda = derivePositionLotPda(programId, marketPda, owner, 4n).address;
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
  const jobs: Parameters<EscrowPositionActivationDatabase['enqueueRelayerJob']>[0][] = [];
  let duplicate = false;
  const db: EscrowPositionActivationDatabase = {
    async getMarketLink() {
      return {
        ok: true, found: true, marketId: MARKET_ID, custodyMode: 'escrow', custodyVersion: 1,
        cluster: 'devnet', genesisHash: GENESIS_HASH, programId, marketPda,
        vaultPda: market.vault, asset: market.asset, mintPubkey: null,
        documentHashHex: 'ab'.repeat(32), oracleEpoch: market.oracleSetEpoch,
        eventEpoch: market.eventEpoch, ratioMilli: BigInt(market.ratioMilli),
        chainState: 'open', commitment: 'finalized', projectionStale: false,
      };
    },
    async enqueueRelayerJob(input) {
      jobs.push(input);
      if (duplicate) return { ok: true, duplicate: true, state: 'pending' };
      duplicate = true;
      return { ok: true, created: true, jobId: 'activation-1' };
    },
  };
  const wrap = <T>(address: string, value: T) => ({ address, ownerProgramId: programId, lamports: 1n, value });
  const chain: EscrowPositionActivationChain = {
    async genesisHash() { return overrides.genesisHash ?? GENESIS_HASH; },
    async market(address) { return address === marketPda ? wrap(marketPda, market) : null; },
    async position(address) { return address === positionPda ? wrap(positionPda, position) : null; },
    async lot(address) { return address === lotPda ? wrap(lotPda, lot) : null; },
  };
  const service = createEscrowPositionActivationService({
    db, chain,
    deployment: { cluster: 'devnet', genesisHash: GENESIS_HASH, programId, custodyVersion: 1, relayerFeePayer: sponsor },
    readiness: async () => ({ status: 'ready', reasons: [] }),
    clock: () => NOW_ISO,
  });
  return { service, jobs, programId, owner, marketPda, positionPda, lotPda };
}

describe('escrow position activation scheduling', () => {
  it('schedules the exact pending lot at its chain activation timestamp and replays idempotently', async () => {
    const fixture = setup();
    const request = { marketPda: fixture.marketPda, owner: fixture.owner, lotNonce: 4n, expectedEventEpoch: 7n };

    await expect(fixture.service.schedule(request)).resolves.toEqual({
      kind: 'enqueued', created: true, jobId: 'activation-1',
    });
    await expect(fixture.service.schedule(request)).resolves.toEqual({
      kind: 'enqueued', created: false, jobId: null,
    });

    expect(fixture.jobs).toHaveLength(2);
    expect(fixture.jobs[0]).toMatchObject({
      kind: 'position_activation', cluster: 'devnet', programId: fixture.programId,
      custodyMode: 'escrow', custodyVersion: 1, marketId: MARKET_ID,
      ownerPubkey: fixture.owner, dueAtIso: '2023-11-14T22:13:30.000Z',
      payload: {
        schemaVersion: 1, operation: 'activate_position_lot', marketId: MARKET_ID,
        marketPda: fixture.marketPda, positionPda: fixture.positionPda,
        positionLotPda: fixture.lotPda, owner: fixture.owner, lotNonce: '4',
        expectedEventEpoch: '7', activationTimestamp: '1700000010',
      },
    });
    expect(fixture.jobs[0]?.idempotencyKey).toBe(fixture.jobs[1]?.idempotencyKey);
  });

  it.each([
    [{ market: { eventEpoch: 8n } }, 'stale_epoch'],
    [{ lot: { state: 'voided' as const, invalidationEvidenceHash: new Uint8Array(32) } }, 'lot_invalidated'],
    [{ genesisHash: 'wrong-genesis' }, 'deployment_mismatch'],
  ] as const)('fails closed for stale, invalidated, or wrong-deployment state', async (overrides, code) => {
    const fixture = setup(overrides);
    await expect(fixture.service.schedule({
      marketPda: fixture.marketPda, owner: fixture.owner, lotNonce: 4n, expectedEventEpoch: 7n,
    })).rejects.toMatchObject({ code });
    expect(fixture.jobs).toHaveLength(0);
  });
});
