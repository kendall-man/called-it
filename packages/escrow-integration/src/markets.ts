import { createHash } from 'node:crypto';
import {
  POSITION_ACTIVATION_DELAY_SECONDS_V1,
  deriveMarketPda,
  deriveSolVaultPda,
  deriveUsdcVaultAddress,
  hashMarketDocumentV1,
  materializeInstruction,
  ratioMilliFromProbabilityPpm,
  type EscrowAsset,
  type MarketDocumentV1,
} from '@calledit/escrow-sdk';
import { PublicKey } from '@solana/web3.js';
import { chainTimestamp, connection, sendInstructions } from './runtime.js';
import type { BootstrapContext, OpenedMarket } from './types.js';

export const MARKET_UUIDS = {
  settlement: '00000000-0000-4000-8000-000000000001',
  usdcVoid: '00000000-0000-4000-8000-000000000002',
  timeout: '00000000-0000-4000-8000-000000000003',
  antiSnipe: '00000000-0000-4000-8000-000000000004',
  replay: '00000000-0000-4000-8000-000000000005',
  replayUsdc: '00000000-0000-4000-8000-000000000006',
} as const;

export type MarketTiming = 'standard' | 'in_play' | 'short_timeout';

function fixtureHash(label: string): Uint8Array {
  return createHash('sha256').update(`calledit-escrow-integration:${label}`).digest();
}

export async function marketDocument(input: {
  readonly context: BootstrapContext;
  readonly marketUuid: string;
  readonly fixtureId: bigint;
  readonly asset: EscrowAsset;
  readonly replay: boolean;
  readonly timing: MarketTiming;
}): Promise<MarketDocumentV1> {
  const now = await chainTimestamp(connection(input.context.rpcUrl));
  const timing = input.timing === 'standard'
    ? { inPlay: now + 120n, cutoff: now + 600n, deadline: now + 1_200n }
    : input.timing === 'in_play'
      ? { inPlay: now - 1n, cutoff: now + 600n, deadline: now + 1_200n }
      : { inPlay: now + 15n, cutoff: now + 20n, deadline: now + 22n };
  const probabilityPpm = 500_000;
  return {
    marketUuid: input.marketUuid,
    fixtureId: input.fixtureId,
    claimSpecificationHash: fixtureHash(`${input.marketUuid}:claim`),
    displayTermsHash: fixtureHash(`${input.marketUuid}:display`),
    asset: input.asset,
    probabilityPpm,
    ratioMilli: ratioMilliFromProbabilityPpm(probabilityPpm),
    oddsMessageHash: fixtureHash(`${input.marketUuid}:odds`),
    oddsTimestamp: now,
    inPlayStartTimestamp: timing.inPlay,
    activationDelaySeconds: POSITION_ACTIVATION_DELAY_SECONDS_V1,
    positionCutoff: timing.cutoff,
    resolutionDeadline: timing.deadline,
    feeBps: 0,
    oracleSetEpoch: input.context.oracleEpoch,
    replayFlag: input.replay,
  };
}

export async function openMarket(context: BootstrapContext, document: MarketDocumentV1): Promise<OpenedMarket> {
  const rpc = connection(context.rpcUrl);
  const documentHash = hashMarketDocumentV1(document);
  const instruction = materializeInstruction({
    kind: 'initialize_market', payer: context.roles.relayer.publicKey,
    marketCreationAuthority: context.roles.marketAuthority.publicKey,
    canonicalUsdcMint: context.canonicalUsdcMint, expectedClusterGenesisHash: context.genesisBytes,
    document, documentHash,
  }, { programId: context.programId });
  await sendInstructions({
    connection: rpc,
    feePayer: context.roles.relayer,
    instructions: [instruction],
    signers: [context.roles.marketAuthority],
  });
  const market = deriveMarketPda(context.programId, document.marketUuid).publicKey;
  const expectedVault = document.asset === 'sol'
    ? deriveSolVaultPda(context.programId, market).publicKey
    : deriveUsdcVaultAddress(market, context.canonicalUsdcMint);
  return { document, documentHash, market, vault: expectedVault };
}

export function solPlaceholder(): PublicKey {
  return PublicKey.default;
}
