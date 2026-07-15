import type { EscrowDb } from '@calledit/db';
import {
  deriveMarketPda,
  deriveOracleSetPda,
  deriveSolVaultPda,
  deriveUsdcVaultAddress,
  type MarketAccount,
  type OracleSetAccount,
  type SettlementAttestationV1,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import { base58Decode } from '@calledit/solana';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { DecodedEscrowAccount } from './solana-accounts.js';
import { createEscrowRecoveryFinalityVerifier } from './recovery-finality.js';
import {
  createEscrowRecoveryTransactionBuilder,
  EscrowRecoveryRelayerError,
  type EscrowRecoveryChain,
} from './recovery-relayer.js';
import {
  createEscrowRecoveryService,
  type EscrowRecoveryDatabase,
  type EscrowRecoveryDeployment,
} from './recovery-workflows.js';
import type { DurableEscrowRelayerJobRow } from './relayer-worker.js';

const PROGRAM_ID = 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL';
const GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const BLOCKHASH = '11111111111111111111111111111111';
const NOW = '2026-07-15T00:00:00.000Z';

function setup(
  asset: 'sol' | 'usdc',
  state: MarketAccount['state'] = 'open',
  marketOverrides: Partial<MarketAccount> = {},
  positionOverrides: Partial<UserPositionAccount> = {},
) {
  const sponsor = Keypair.generate();
  const residual = Keypair.generate();
  const mint = Keypair.generate();
  const signers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const marketPda = deriveMarketPda(PROGRAM_ID, MARKET_ID).address;
  const vault = asset === 'sol'
    ? deriveSolVaultPda(PROGRAM_ID, marketPda).address
    : deriveUsdcVaultAddress(marketPda, mint.publicKey).toBase58();
  const documentHash = Uint8Array.from({ length: 32 }, () => 0xab);
  const market: MarketAccount = {
    version: 1, bump: 1, marketUuid: MARKET_ID, fixtureId: 77n,
    claimSpecificationHash: Uint8Array.from({ length: 32 }, () => 1),
    displayTermsHash: Uint8Array.from({ length: 32 }, () => 2),
    oddsMessageHash: Uint8Array.from({ length: 32 }, () => 3), marketDocumentHash: documentHash,
    quoteTimestamp: 1n, probabilityPpm: 500_000, ratioMilli: 1_500,
    asset, tokenMint: asset === 'usdc' ? mint.publicKey.toBase58() : null, feeBps: 0,
    state, replay: false, createdTimestamp: 1n, inPlayStartTimestamp: 2n,
    activationDelaySeconds: 0n, positionCutoffTimestamp: 3n, resolutionDeadline: 4n,
    oracleSetEpoch: 7n, eventEpoch: 3n, activeBackTotal: 25n, activeDoubtTotal: 25n,
    pendingBackTotal: 0n, pendingDoubtTotal: 0n, finalMatchedBackTotal: 25n,
    finalMatchedDoubtTotal: 25n, finalForfeitedTotal: 0n,
    settlementProcessedPositionCount: state === 'settled' ? 1n : 0n,
    settlementOutcome: state === 'settled' ? 'claim_won' : null,
    settlementEvidenceHash: state === 'settled' ? Uint8Array.from({ length: 32 }, () => 9) : null,
    positionCount: 1n, claimedPositionCount: 0n, vault, vaultBump: 1,
    residualRecipient: residual.publicKey.toBase58(),
    ...marketOverrides,
  };
  const owner = Keypair.generate();
  const position: UserPositionAccount = {
    version: 1, bump: 1, market: marketPda, owner: owner.publicKey.toBase58(), side: 'back',
    activeAmount: 25n, pendingAmount: 0n, refundableAmount: 0n,
    settlementBaseEntitlement: state === 'settled' ? 25n : 0n,
    settlementProcessed: state === 'settled', nextLotNonce: 1n, claimed: false,
    totalPaidAmount: 25n, createdSlot: 1n, updatedSlot: 2n,
    ...positionOverrides,
  };
  const oracle: OracleSetAccount = {
    version: 1, bump: 1, epoch: 7n, signers: signers.map((value) => value.publicKey.toBase58()),
    signatureThreshold: 2, activationSlot: 1n, retirementSlot: 2n,
  };
  const deployment: EscrowRecoveryDeployment = {
    cluster: 'devnet', genesisHash: GENESIS_HASH, programId: PROGRAM_ID,
    canonicalUsdcMint: mint.publicKey.toBase58(), relayerFeePayer: sponsor.publicKey.toBase58(),
    residualRecipient: residual.publicKey.toBase58(), custodyVersion: 1,
  };
  const link = {
    ok: true as const, found: true as const, marketId: MARKET_ID, custodyMode: 'escrow' as const,
    custodyVersion: 1, cluster: 'devnet' as const, genesisHash: GENESIS_HASH, programId: PROGRAM_ID,
    marketPda, vaultPda: vault, asset, mintPubkey: market.tokenMint,
    documentHashHex: 'ab'.repeat(32), oracleEpoch: 7n, eventEpoch: 3n, ratioMilli: 1_500n,
    chainState: state === 'settled' ? 'settled' as const : 'open' as const,
    commitment: 'finalized' as const, projectionStale: false,
  };
  const jobs: Parameters<EscrowRecoveryDatabase['enqueueRelayerJob']>[0][] = [];
  const keys = new Set<string>();
  const db: EscrowRecoveryDatabase = {
    async getMarketLink() { return link; },
    async enqueueRelayerJob(input) {
      jobs.push(input);
      const created = !keys.has(input.idempotencyKey);
      keys.add(input.idempotencyKey);
      return { ok: true, created, jobId: 'job-a' };
    },
  };
  const decoded = <T>(address: string, value: T): DecodedEscrowAccount<T> => ({
    address, ownerProgramId: PROGRAM_ID, lamports: 1n, value,
  });
  const chain: EscrowRecoveryChain = {
    async genesisHash() { return GENESIS_HASH; },
    async latestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 900n }; },
    async market(address) { return address === marketPda ? decoded(address, market) : null; },
    async position() { return decoded('position-pda', position); },
    async oracleSet(address) {
      return address === deriveOracleSetPda(PROGRAM_ID, 7n).address ? decoded(address, oracle) : null;
    },
    async accountExists() { return false; },
  };
  const attestation: SettlementAttestationV1 = {
    clusterGenesisHash: base58Decode(GENESIS_HASH), escrowProgramId: base58Decode(PROGRAM_ID),
    marketPda: base58Decode(marketPda), marketDocumentHash: documentHash, fixtureId: 77n,
    oracleSetEpoch: 7n, issuedAt: 10n, expiresAt: 20n,
    evidenceHash: Uint8Array.from({ length: 32 }, () => 9), outcome: 'claim_won',
    decidingSequence: 88n, terminalPhase: 'ended', regulationScore: { home: 1, away: 0 },
    fullMatchScore: { home: 1, away: 0 },
    evidenceSequenceCommitment: Uint8Array.from({ length: 32 }, () => 4),
    normalizedEvidenceRoot: Uint8Array.from({ length: 32 }, () => 5),
  };
  const signatures = signers.slice(0, 2).map((value, index) => ({
    publicKey: value.publicKey.toBytes(), signature: Uint8Array.from({ length: 64 }, () => index + 1),
  }));
  const service = createEscrowRecoveryService({
    db, deployment, readiness: async () => ({ status: 'ready', reasons: [] }), clock: () => NOW,
  });
  return { sponsor, owner, market, position, oracle, deployment, link, jobs, db, chain, attestation, signatures, service };
}

function leasedJob(input: Parameters<EscrowRecoveryDatabase['enqueueRelayerJob']>[0]): DurableEscrowRelayerJobRow {
  return {
    id: 'job-a', ...input, state: 'leased', attempts: 1, leaseDurationMs: 60_000,
    dueAt: input.dueAtIso, leaseOwner: 'worker-a', leaseToken: 'lease-a', leaseExpiresAt: NOW,
    expectedSignature: null, rawTransactionBase64: null, transactionMessageHashHex: null,
    lastValidBlockHeight: null, errorCode: null, createdAt: NOW, updatedAt: NOW,
  };
}

describe('durable escrow recovery workflows', () => {
  it('enqueues pinned-epoch settlement idempotently without a legacy ledger dependency', async () => {
    const fixture = setup('sol');
    const request = {
      operation: 'settle_market' as const, marketPda: fixture.link.marketPda,
      attestation: fixture.attestation, signatures: fixture.signatures,
    };

    await expect(fixture.service.enqueue(request)).resolves.toMatchObject({ kind: 'enqueued', created: true });
    await expect(fixture.service.enqueue(request)).resolves.toMatchObject({ kind: 'enqueued', created: false });
    expect(fixture.jobs[0]).toMatchObject({
      kind: 'settlement_submission', custodyMode: 'escrow', ownerPubkey: null,
      payload: { operation: 'settle_market', oracleEpoch: '7' },
    });
    expect('insertLedger' in fixture.db).toBe(false);
  });

  it('dedupes retries of one lot-close batch while enqueueing the next batch for the same owner', async () => {
    const fixture = setup('sol', 'settled', {}, { claimed: true, nextLotNonce: 10n });
    const firstBatch = {
      operation: 'close_position_lots' as const,
      marketPda: fixture.link.marketPda,
      owner: fixture.owner.publicKey.toBase58(),
      lotNonces: [9n, 8n, 7n, 6n, 5n, 4n, 3n, 2n],
    };
    const secondBatch = { ...firstBatch, lotNonces: [1n, 0n] };

    await expect(fixture.service.enqueue(firstBatch))
      .resolves.toMatchObject({ kind: 'enqueued', created: true });
    await expect(fixture.service.enqueue(firstBatch))
      .resolves.toMatchObject({ kind: 'enqueued', created: false });
    await expect(fixture.service.enqueue(secondBatch))
      .resolves.toMatchObject({ kind: 'enqueued', created: true });

    const keys = fixture.jobs.map((job) => job.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys.every((key) => key.length < 256)).toBe(true);

    const input = fixture.jobs[0];
    if (input === undefined) throw new Error('expected recovery job');
    const builder = createEscrowRecoveryTransactionBuilder({
      db: fixture.db, chain: fixture.chain, sponsor: fixture.sponsor,
      deployment: fixture.deployment,
    });
    const built = await builder.build(leasedJob(input));
    expect(Buffer.from(built.rawTransactionBase64, 'base64').length).toBeLessThanOrEqual(1_232);
  });

  it('materializes the compact canonical threshold settlement within the transaction packet limit', async () => {
    const fixture = setup('sol');
    await fixture.service.enqueue({
      operation: 'settle_market', marketPda: fixture.link.marketPda,
      attestation: fixture.attestation, signatures: fixture.signatures,
    });
    const input = fixture.jobs[0];
    if (input === undefined) throw new Error('expected recovery job');
    const builder = createEscrowRecoveryTransactionBuilder({
      db: fixture.db, chain: fixture.chain, sponsor: fixture.sponsor, deployment: fixture.deployment,
    });

    const built = await builder.build(leasedJob(input));
    expect(Buffer.from(built.rawTransactionBase64, 'base64').length).toBeLessThanOrEqual(1_232);
    expect(built.lastValidBlockHeight).toBe(900n);
  });

  it('fails closed when signatures do not meet the pinned oracle membership threshold', async () => {
    const fixture = setup('sol');
    await fixture.service.enqueue({
      operation: 'settle_market', marketPda: fixture.link.marketPda,
      attestation: fixture.attestation,
      signatures: [{ publicKey: Keypair.generate().publicKey.toBytes(), signature: new Uint8Array(64) }],
    });
    const input = fixture.jobs[0];
    if (input === undefined) throw new Error('expected recovery job');
    const builder = createEscrowRecoveryTransactionBuilder({
      db: fixture.db, chain: fixture.chain, sponsor: fixture.sponsor, deployment: fixture.deployment,
    });

    await expect(builder.build(leasedJob(input))).rejects.toBeInstanceOf(EscrowRecoveryRelayerError);
  });

  it('materializes void, timeout, entitlement, claim-for, and close recovery operations', async () => {
    const cases = [
      {
        fixture: setup('sol'),
        request: (fixture: ReturnType<typeof setup>) => ({
          operation: 'void_market' as const, marketPda: fixture.link.marketPda,
          attestation: {
            clusterGenesisHash: fixture.attestation.clusterGenesisHash,
            escrowProgramId: fixture.attestation.escrowProgramId,
            marketPda: fixture.attestation.marketPda,
            marketDocumentHash: fixture.attestation.marketDocumentHash,
            fixtureId: fixture.attestation.fixtureId, oracleSetEpoch: fixture.attestation.oracleSetEpoch,
            issuedAt: 10n, expiresAt: 20n, evidenceHash: fixture.attestation.evidenceHash,
            reason: 'cancelled' as const, decidingSequence: 88n,
          },
          signatures: fixture.signatures,
        }),
      },
      { fixture: setup('sol'), request: (fixture: ReturnType<typeof setup>) => ({ operation: 'timeout_void' as const, marketPda: fixture.link.marketPda }) },
      { fixture: setup('sol', 'settling'), request: (fixture: ReturnType<typeof setup>) => ({ operation: 'calculate_position_entitlement' as const, marketPda: fixture.link.marketPda, owner: fixture.owner.publicKey.toBase58() }) },
      { fixture: setup('usdc', 'settled'), request: (fixture: ReturnType<typeof setup>) => ({ operation: 'claim_position_for' as const, marketPda: fixture.link.marketPda, owner: fixture.owner.publicKey.toBase58() }) },
      { fixture: setup('sol', 'settled', {}, { claimed: true }), request: (fixture: ReturnType<typeof setup>) => ({ operation: 'close_position_lots' as const, marketPda: fixture.link.marketPda, owner: fixture.owner.publicKey.toBase58(), lotNonces: [0n] }) },
      { fixture: setup('sol', 'settled', {}, { claimed: true, nextLotNonce: 0n }), request: (fixture: ReturnType<typeof setup>) => ({ operation: 'close_position' as const, marketPda: fixture.link.marketPda, owner: fixture.owner.publicKey.toBase58() }) },
      { fixture: setup('usdc', 'settled', { claimedPositionCount: 1n, settlementProcessedPositionCount: 0n }), request: (fixture: ReturnType<typeof setup>) => ({ operation: 'close_market' as const, marketPda: fixture.link.marketPda }) },
    ];

    for (const item of cases) {
      await item.fixture.service.enqueue(item.request(item.fixture));
      const input = item.fixture.jobs[0];
      if (input === undefined) throw new Error('expected recovery job');
      const builder = createEscrowRecoveryTransactionBuilder({
        db: item.fixture.db, chain: item.fixture.chain,
        sponsor: item.fixture.sponsor, deployment: item.fixture.deployment,
      });
      await expect(builder.build(leasedJob(input))).resolves.toMatchObject({ lastValidBlockHeight: 900n });
    }
  });

  it.each(['sol', 'usdc'] as const)('builds an unsigned direct-owner %s claim', async (asset) => {
    const fixture = setup(asset, 'settled');
    const builder = createEscrowRecoveryTransactionBuilder({
      db: fixture.db, chain: fixture.chain, sponsor: fixture.sponsor, deployment: fixture.deployment,
    });

    const built = await builder.buildDirectClaim({
      marketPda: fixture.link.marketPda, owner: fixture.owner.publicKey.toBase58(),
    });
    const transaction = VersionedTransaction.deserialize(Buffer.from(built.rawTransactionBase64, 'base64'));
    expect(transaction.message.staticAccountKeys[0]?.toBase58()).toBe(fixture.owner.publicKey.toBase58());
    expect(transaction.signatures).toHaveLength(1);
    expect(transaction.signatures[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it('confirms the exact finalized settlement effect and rejects a contradictory terminal state', async () => {
    const fixture = setup('sol', 'settling', {
      settlementOutcome: 'claim_won',
      settlementEvidenceHash: Uint8Array.from({ length: 32 }, () => 9),
    });
    await fixture.service.enqueue({
      operation: 'settle_market', marketPda: fixture.link.marketPda,
      attestation: fixture.attestation, signatures: fixture.signatures,
    });
    const input = fixture.jobs[0];
    if (input === undefined) throw new Error('expected recovery job');
    const scheduled: unknown[] = [];
    const verifier = createEscrowRecoveryFinalityVerifier({
      chain: fixture.chain,
      programId: PROGRAM_ID,
      entitlements: {
        async afterSettlementFinalized(input) { scheduled.push(input); },
      },
    });

    await expect(verifier.confirm(leasedJob(input), { signature: 'sig-a', slot: 42n }))
      .resolves.toBe('confirmed');
    expect(scheduled).toEqual([{
      marketId: MARKET_ID, marketPda: fixture.link.marketPda, positionCount: 1n,
    }]);
    const mismatchedVerifier = createEscrowRecoveryFinalityVerifier({
      programId: PROGRAM_ID,
      chain: {
        ...fixture.chain,
        async market(address) {
          const value = await fixture.chain.market(address);
          return value === null ? null : {
            ...value, value: {
              ...value.value,
              state: 'settled',
              settlementProcessedPositionCount: value.value.positionCount,
              settlementOutcome: 'claim_lost',
            },
          };
        },
      },
    });
    await expect(mismatchedVerifier.confirm(leasedJob(input), { signature: 'sig-a', slot: 42n }))
      .resolves.toBe('mismatch');
  });

  it('keeps finalized settlement retryable until entitlement jobs are durably enqueued', async () => {
    const fixture = setup('sol', 'settling', {
      settlementOutcome: 'claim_won',
      settlementEvidenceHash: Uint8Array.from({ length: 32 }, () => 9),
    });
    await fixture.service.enqueue({
      operation: 'settle_market', marketPda: fixture.link.marketPda,
      attestation: fixture.attestation, signatures: fixture.signatures,
    });
    const input = fixture.jobs[0];
    if (input === undefined) throw new Error('expected recovery job');
    const verifier = createEscrowRecoveryFinalityVerifier({
      chain: fixture.chain,
      programId: PROGRAM_ID,
      entitlements: {
        async afterSettlementFinalized() { throw new Error('durable storage unavailable'); },
      },
    });

    await expect(verifier.confirm(leasedJob(input), { signature: 'sig-a', slot: 42n }))
      .rejects.toThrow('durable storage unavailable');
  });
});
