import type { EscrowRelayerJobRow } from '@calledit/db';
import {
  bytesToHex,
  deriveMarketPda,
  deriveOracleSetPda,
  deriveProtocolConfigPda,
  deriveSolVaultPda,
} from '@calledit/escrow-sdk';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { buildImmutableMarketDocument } from './market-document.js';
import {
  createMarketInitializationFinalityVerifier,
  createMarketInitializationTransactionBuilder,
  EscrowMarketRelayerError,
  type EscrowMarketRelayerChain,
} from './market-relayer.js';

const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const GENESIS_HEX = 'ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab';
const BLOCKHASH = '11111111111111111111111111111111';

function setup() {
  const program = Keypair.generate();
  const sponsor = Keypair.generate();
  const authority = Keypair.generate();
  const mint = Keypair.generate();
  const immutable = buildImmutableMarketDocument({
    marketId: MARKET_ID, fixtureId: 77n, claimSpecification: 'claim', displayTerms: 'terms',
    asset: 'sol', probability: 0.4, oddsMessage: new TextEncoder().encode('odds'),
    oddsTimestamp: 100n, kickoffTimestamp: 200n, positionCutoffTimestamp: 300n,
    resolutionDeadlineTimestamp: 400n, oracleSetEpoch: 9n, replay: false,
  });
  const marketPda = deriveMarketPda(program.publicKey, MARKET_ID).address;
  const configPda = deriveProtocolConfigPda(program.publicKey).address;
  const oracleSetPda = deriveOracleSetPda(program.publicKey, 9n).address;
  const vaultPda = deriveSolVaultPda(program.publicKey, marketPda).address;
  const payload = {
    schemaVersion: 1, cluster: 'devnet', genesisHash: GENESIS, clusterGenesisHashHex: GENESIS_HEX,
    programId: program.publicKey.toBase58(), protocolConfigPda: configPda, oracleSetPda,
    marketCreationAuthority: authority.publicKey.toBase58(), relayerFeePayer: sponsor.publicKey.toBase58(),
    canonicalUsdcMint: mint.publicKey.toBase58(), marketUuid: MARKET_ID, fixtureId: '77',
    claimSpecificationHashHex: immutable.claimSpecificationHashHex,
    displayTermsHashHex: immutable.displayTermsHashHex, asset: 'sol', probabilityPpm: 400_000,
    ratioMilli: 1_500, oddsMessageHashHex: immutable.oddsMessageHashHex, oddsTimestamp: '100',
    inPlayStartTimestamp: '200', activationDelaySeconds: '150', positionCutoff: '300',
    resolutionDeadline: '400', feeBps: 0, oracleSetEpoch: '9', replayFlag: false,
    documentHashHex: immutable.documentHashHex, marketPda, vaultPda,
  } as const;
  const job: EscrowRelayerJobRow = {
    id: '123e4567-e89b-12d3-a456-426614174111', kind: 'market_initialization',
    idempotencyKey: 'init-a', state: 'leased', cluster: 'devnet', programId: payload.programId,
    custodyMode: 'escrow', custodyVersion: 1, marketId: MARKET_ID, ownerPubkey: null, payload,
    attempts: 1, maxAttempts: 8, leaseDurationMs: 60_000, dueAt: '2026-07-15T00:00:00.000Z',
    leaseOwner: 'worker-a', leaseToken: '123e4567-e89b-12d3-a456-426614174222',
    leaseExpiresAt: '2026-07-15T00:01:00.000Z', expectedSignature: null,
    rawTransactionBase64: null, transactionMessageHashHex: null, lastValidBlockHeight: null,
    errorCode: null, createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
  };
  const observation = {
    genesisHash: GENESIS, programExecutable: true, programId: payload.programId,
    configPda, configOwnerProgramId: payload.programId, paused: false,
    configGenesisHashHex: GENESIS_HEX, canonicalUsdcMint: payload.canonicalUsdcMint,
    marketCreationAuthority: payload.marketCreationAuthority, relayerFeePayer: payload.relayerFeePayer,
    oracleSetPda, oracleOwnerProgramId: payload.programId, oracleSetEpoch: 9n,
    marketExists: false,
  } as const;
  const chain: EscrowMarketRelayerChain = {
    inspectInitialization: async () => observation,
    latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 900n }),
  };
  const builder = createMarketInitializationTransactionBuilder({
    chain, sponsor, marketCreationAuthority: authority,
    expected: {
      cluster: 'devnet', genesisHash: GENESIS, programId: payload.programId,
      protocolConfigPda: configPda, oracleSetPda, oracleSetEpoch: 9n,
      canonicalUsdcMint: payload.canonicalUsdcMint,
      marketCreationAuthority: payload.marketCreationAuthority,
      relayerFeePayer: payload.relayerFeePayer,
    },
  });
  const expected = {
    cluster: 'devnet' as const, genesisHash: GENESIS, programId: payload.programId,
    protocolConfigPda: configPda, oracleSetPda, oracleSetEpoch: 9n,
    canonicalUsdcMint: payload.canonicalUsdcMint,
    marketCreationAuthority: payload.marketCreationAuthority,
    relayerFeePayer: payload.relayerFeePayer,
  };
  return { builder, job, payload, observation, sponsor, authority, expected };
}

describe('market initialization relayer', () => {
  it('rebuilds and signs only the fully pinned initialization', async () => {
    // Given a job whose immutable identities match live RPC state
    const fixture = setup();

    // When the executable builder materializes the SDK instruction
    const result = await fixture.builder.build(fixture.job);

    // Then both operational signers authorize one unchanged message
    const transaction = VersionedTransaction.deserialize(Buffer.from(result.rawTransactionBase64, 'base64'));
    expect(result.transactionMessageHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(transaction.signatures).toHaveLength(2);
    expect(transaction.signatures.every((signature) => signature.some((byte) => byte !== 0))).toBe(true);
    expect(bytesToHex(transaction.message.staticAccountKeys[0]?.toBytes() ?? new Uint8Array()))
      .toBe(bytesToHex(fixture.sponsor.publicKey.toBytes()));
  });

  it.each(['genesisHash', 'programId', 'protocolConfigPda', 'oracleSetPda'] as const)(
    'fails closed when the durable %s identity is substituted',
    async (field) => {
      // Given one persisted identity replaced after enqueue
      const fixture = setup();
      const tampered = {
        ...fixture.job,
        payload: { ...fixture.payload, [field]: Keypair.generate().publicKey.toBase58() },
      };

      // When materialization runs, then no transaction is signed
      await expect(fixture.builder.build(tampered)).rejects.toBeInstanceOf(EscrowMarketRelayerError);
    },
  );

  it('confirms only the exact finalized market account', async () => {
    const fixture = setup();
    const record = {
      ownerProgramId: fixture.payload.programId,
      marketPda: fixture.payload.marketPda,
      vaultPda: fixture.payload.vaultPda,
      documentHashHex: fixture.payload.documentHashHex,
      asset: fixture.payload.asset,
      tokenMint: null,
      oracleSetEpoch: 9n,
      ratioMilli: fixture.payload.ratioMilli,
      state: 'open' as const,
    };
    const verifier = createMarketInitializationFinalityVerifier({
      expected: fixture.expected,
      chain: { async readMarket() { return record; } },
    });

    await expect(verifier.confirm(fixture.job)).resolves.toBe('confirmed');
    const mismatched = createMarketInitializationFinalityVerifier({
      expected: fixture.expected,
      chain: { async readMarket() { return { ...record, documentHashHex: '00'.repeat(32) }; } },
    });
    await expect(mismatched.confirm(fixture.job)).resolves.toBe('mismatch');
  });
});
