import {
  deriveMarketPda,
  type MarketAccount,
  type OracleSetAccount,
  type PositionLotAccount,
} from '@calledit/escrow-sdk';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createLocalEscrowOracleAttestationProvider } from './attestation-signers.js';
import { createEscrowControlTransactionBuilder, type EscrowControlChain } from './control-relayer.js';
import {
  createEscrowControlService,
  type EscrowControlDatabase,
  type EscrowControlDeployment,
} from './control-workflows.js';
import { buildEscrowFeedEventAttestation } from './event-attestations.js';
import type { DecodedEscrowAccount } from './solana-accounts.js';
import type { DurableEscrowRelayerJobRow } from './relayer-worker.js';

const PROGRAM_ID = 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const NOW = '2026-07-15T00:00:00.000Z';

function leased(input: Parameters<EscrowControlDatabase['enqueueRelayerJob']>[0]): DurableEscrowRelayerJobRow {
  return {
    id: 'control-job', ...input, state: 'leased', attempts: 1, leaseDurationMs: 60_000,
    dueAt: input.dueAtIso, leaseOwner: 'worker-a', leaseToken: 'lease-a', leaseExpiresAt: NOW,
    expectedSignature: null, rawTransactionBase64: null, transactionMessageHashHex: null,
    lastValidBlockHeight: null, errorCode: null, createdAt: NOW, updatedAt: NOW,
  };
}

describe('durable escrow control workflows', () => {
  it('queues idempotently and materializes a separately authorized 2-of-3 freeze transaction', async () => {
    const sponsor = Keypair.generate();
    const feed = Keypair.generate();
    const oracles = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const marketPda = deriveMarketPda(PROGRAM_ID, MARKET_ID).address;
    const deployment: EscrowControlDeployment = {
      cluster: 'devnet', genesisHash: GENESIS, programId: PROGRAM_ID,
      custodyVersion: 1, feedOperatorAuthority: feed.publicKey.toBase58(),
    };
    const link = {
      ok: true as const, found: true as const, marketId: MARKET_ID, custodyMode: 'escrow' as const,
      custodyVersion: 1, cluster: 'devnet' as const, genesisHash: GENESIS, programId: PROGRAM_ID,
      marketPda, vaultPda: Keypair.generate().publicKey.toBase58(), asset: 'sol' as const,
      mintPubkey: null, documentHashHex: 'ab'.repeat(32), oracleEpoch: 7n,
      eventEpoch: 3n, ratioMilli: 1_500n, chainState: 'open' as const,
      commitment: 'finalized' as const, projectionStale: false,
    };
    const jobs: Parameters<EscrowControlDatabase['enqueueRelayerJob']>[0][] = [];
    const keys = new Set<string>();
    const db: EscrowControlDatabase = {
      async getMarketLink() { return link; },
      async enqueueRelayerJob(input) {
        jobs.push(input);
        const created = !keys.has(input.idempotencyKey);
        keys.add(input.idempotencyKey);
        return { ok: true, created, jobId: 'control-job' };
      },
    };
    const event = {
      kind: 'var_check' as const, fixtureId: 77, seq: 12, tsMs: 100_000,
      receivedAtMs: 101_000, confirmed: true, phase: 'H1' as const, minute: 20,
      score: {
        p1: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
        p2: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
        p1Goals90: null, p2Goals90: null,
      },
    };
    const attestation = buildEscrowFeedEventAttestation({
      deployment: { genesisHash: GENESIS, programId: PROGRAM_ID },
      market: {
        marketId: MARKET_ID, marketPda, marketDocumentHashHex: 'ab'.repeat(32),
        fixtureId: 77n, oracleSetEpoch: 7n, eventEpoch: 3n,
      },
      event, issuedAt: 100n, ttlSeconds: 300n, eventKind: 'freeze',
    });
    const provider = createLocalEscrowOracleAttestationProvider({
      network: 'devnet', authorizedSignerAddresses: oracles.map((value) => value.publicKey.toBase58()),
      signers: oracles, threshold: 2,
      forbiddenSignerAddresses: [sponsor.publicKey.toBase58(), feed.publicKey.toBase58()],
    });
    const signatures = await provider.sign({
      kind: 'feed_event', attestation,
      evidenceCodecVersion: 2,
      claimSpecificationJson: '{"claimType":"match_winner"}',
    });
    const service = createEscrowControlService({
      db, deployment, readiness: async () => ({ status: 'ready', reasons: [] }), clock: () => NOW,
    });
    const request = {
      operation: 'freeze_market' as const, marketPda, expectedEventEpoch: 3n, attestation, signatures,
    };

    await expect(service.enqueue(request)).resolves.toMatchObject({ kind: 'enqueued', created: true });
    await expect(service.enqueue(request)).resolves.toMatchObject({ kind: 'enqueued', created: false });
    expect(jobs[0]).toMatchObject({ kind: 'freeze', custodyMode: 'escrow', ownerPubkey: null });
    expect('postLedger' in db).toBe(false);

    const decoded = <T>(address: string, value: T): DecodedEscrowAccount<T> => ({
      address, ownerProgramId: PROGRAM_ID, lamports: 1n, value,
    });
    const market = {
      marketUuid: MARKET_ID, marketDocumentHash: new Uint8Array(32).fill(0xab), fixtureId: 77n,
      oracleSetEpoch: 7n, eventEpoch: 3n, state: 'open',
    } as MarketAccount;
    const oracle = {
      version: 1, bump: 1, epoch: 7n, signatureThreshold: 2,
      signers: oracles.map((value) => value.publicKey.toBase58()),
      activationSlot: 1n, retirementSlot: null,
    } satisfies OracleSetAccount;
    const chain: EscrowControlChain = {
      async genesisHash() { return GENESIS; },
      async latestBlockhash() { return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 99n }; },
      async market(address) { return address === marketPda ? decoded(address, market) : null; },
      async lot() { return null as DecodedEscrowAccount<PositionLotAccount> | null; },
      async oracleSet() { return decoded('oracle', oracle); },
    };
    const builder = createEscrowControlTransactionBuilder({
      db, chain, sponsor, feedOperator: feed, deployment,
    });
    const input = jobs[0];
    if (input === undefined) throw new Error('expected control job');
    const built = await builder.build(leased(input));
    const transaction = VersionedTransaction.deserialize(Buffer.from(built.rawTransactionBase64, 'base64'));

    expect(transaction.message.header.numRequiredSignatures).toBe(2);
    expect(transaction.signatures.every((signature) => signature.some((byte) => byte !== 0))).toBe(true);
    expect(built.lastValidBlockHeight).toBe(99n);
  });
});
