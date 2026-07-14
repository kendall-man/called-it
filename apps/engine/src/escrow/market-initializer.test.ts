import type { EscrowDb, EscrowRelayerMutationResult } from '@calledit/db';
import {
  deriveMarketPda,
  deriveOracleSetPda,
  deriveProtocolConfigPda,
  deriveSolVaultPda,
  deriveUsdcVaultAddress,
} from '@calledit/escrow-sdk';
import { describe, expect, it } from 'vitest';
import {
  createMarketInitializationService,
  EscrowMarketInitializationError,
  type EscrowMarketChainRecord,
} from './market-initializer.js';
import type { ImmutableMarketDocumentInput } from './market-document.js';

const PROGRAM_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MARKET_AUTHORITY = '11111111111111111111111111111111';
const RELAYER_FEE_PAYER = 'Vote111111111111111111111111111111111111111';
const GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const NOW = '2026-07-15T00:00:00.000Z';

const DOCUMENT: ImmutableMarketDocumentInput = {
  marketId: MARKET_ID,
  fixtureId: 77n,
  claimSpecification: '{"kind":"team_score","team":"home"}',
  displayTerms: 'Home scores in regulation',
  asset: 'sol',
  probability: 0.4,
  oddsMessage: new TextEncoder().encode('txline:fixture-77:sequence-18'),
  oddsTimestamp: 1_700_000_000n,
  kickoffTimestamp: 1_700_003_600n,
  positionCutoffTimestamp: 1_700_007_200n,
  resolutionDeadlineTimestamp: 1_700_010_800n,
  oracleSetEpoch: 9n,
  replay: false,
};

function setup(options: {
  readonly existing?: EscrowMarketChainRecord | null;
  readonly ready?: boolean;
  readonly enqueueResult?: EscrowRelayerMutationResult;
} = {}) {
  const enqueued: Parameters<EscrowDb['enqueueRelayerJob']>[0][] = [];
  const db: Pick<EscrowDb, 'enqueueRelayerJob'> = {
    async enqueueRelayerJob(input) {
      enqueued.push(input);
      return options.enqueueResult ?? { ok: true, created: true, jobId: 'job-a' };
    },
  };
  const service = createMarketInitializationService({
    db,
    deployment: {
      cluster: 'devnet',
      genesisHash: GENESIS_HASH,
      programId: PROGRAM_ID,
      canonicalUsdcMint: USDC_MINT,
      marketCreationAuthority: MARKET_AUTHORITY,
      relayerFeePayer: RELAYER_FEE_PAYER,
      oracleSetEpoch: 9n,
      custodyVersion: 1,
    },
    chain: {
      readMarket: async () => options.existing ?? null,
    },
    readiness: async () => options.ready === false
      ? { status: 'not_ready', reasons: ['rpc_unavailable'] }
      : { status: 'ready', reasons: [] },
  });
  return { service, enqueued };
}

describe('durable escrow market initialization', () => {
  it.each(['sol', 'usdc'] as const)('enqueues one immutable %s initialization', async (asset) => {
    // Given a ready deployment with no market account
    const { service, enqueued } = setup();

    // When initialization is requested
    const result = await service.initialize({
      document: { ...DOCUMENT, asset },
      nowIso: NOW,
      maxAttempts: 6,
    });

    // Then the durable job pins the document and the asset-specific vault
    const market = deriveMarketPda(PROGRAM_ID, MARKET_ID).publicKey;
    const expectedVault = asset === 'sol'
      ? deriveSolVaultPda(PROGRAM_ID, market).address
      : deriveUsdcVaultAddress(market, USDC_MINT).toBase58();
    expect(result).toMatchObject({ kind: 'queued', created: true, marketPda: market.toBase58() });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      kind: 'market_initialization',
      custodyMode: 'escrow',
      custodyVersion: 1,
      marketId: MARKET_ID,
      payload: {
        asset,
        vaultPda: expectedVault,
        genesisHash: GENESIS_HASH,
        clusterGenesisHashHex: 'ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab',
        programId: PROGRAM_ID,
        marketCreationAuthority: MARKET_AUTHORITY,
        relayerFeePayer: RELAYER_FEE_PAYER,
        protocolConfigPda: deriveProtocolConfigPda(PROGRAM_ID).address,
        oracleSetPda: deriveOracleSetPda(PROGRAM_ID, 9n).address,
        oracleSetEpoch: '9',
        probabilityPpm: 400_000,
        ratioMilli: 1_500,
      },
    });
  });

  it('returns the existing exact chain account without enqueueing again', async () => {
    // Given an initialization that is already finalized on chain
    const first = setup();
    const queued = await first.service.initialize({ document: DOCUMENT, nowIso: NOW, maxAttempts: 6 });
    if (queued.kind !== 'queued') throw new Error('expected queued market');
    const existing: EscrowMarketChainRecord = {
      ownerProgramId: PROGRAM_ID,
      marketPda: queued.marketPda,
      vaultPda: queued.vaultPda,
      documentHashHex: queued.documentHashHex,
      asset: 'sol',
      tokenMint: null,
      oracleSetEpoch: 9n,
      ratioMilli: 1_500,
      state: 'open',
    };
    const restarted = setup({ existing });

    // When the service restarts and receives the same request
    const result = await restarted.service.initialize({ document: DOCUMENT, nowIso: NOW, maxAttempts: 6 });

    // Then chain state is authoritative and no second job is created
    expect(result.kind).toBe('initialized');
    expect(restarted.enqueued).toHaveLength(0);
  });

  it('fails closed on readiness and immutable account mismatches', async () => {
    // Given an unhealthy deployment and a wrong-program market observation
    const blocked = setup({ ready: false });
    const queued = await setup().service.initialize({ document: DOCUMENT, nowIso: NOW, maxAttempts: 6 });
    if (queued.kind !== 'queued') throw new Error('expected queued market');
    const mismatch = setup({
      existing: {
        ownerProgramId: '11111111111111111111111111111111',
        marketPda: queued.marketPda,
        vaultPda: queued.vaultPda,
        documentHashHex: queued.documentHashHex,
        asset: 'sol',
        tokenMint: null,
        oracleSetEpoch: 9n,
        ratioMilli: 1_500,
        state: 'open',
      },
    });

    // When initialization is attempted, then neither condition can publish a market
    await expect(blocked.service.initialize({ document: DOCUMENT, nowIso: NOW, maxAttempts: 6 }))
      .resolves.toEqual({ kind: 'blocked', reasons: ['rpc_unavailable'] });
    await expect(mismatch.service.initialize({ document: DOCUMENT, nowIso: NOW, maxAttempts: 6 }))
      .rejects.toBeInstanceOf(EscrowMarketInitializationError);
  });
});
