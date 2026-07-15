import { Keypair, PublicKey } from '@solana/web3.js';
import {
  deriveMarketPda,
  derivePositionLotPda,
} from '../src/addresses.js';
import type {
  FeedEventAttestationV1,
  PositionInvalidationAttestationV1,
  SettlementAttestationV1,
  VoidAttestationV1,
} from '../src/attestations.js';
import { hashMarketDocumentV1, type MarketDocumentV1 } from '../src/domain.js';
import type { EscrowInstructionRequest } from '../src/instructions.js';
import { DEVNET_ESCROW_PROGRAM_ID } from '../src/schema.js';
import type { SponsoredPositionBuildOptions } from '../src/transactions.js';

export const keypair = (byte: number): Keypair => Keypair.fromSeed(new Uint8Array(32).fill(byte));
export const key = (byte: number): PublicKey => keypair(byte).publicKey;
export const hash = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

export const PROGRAM_ID = new PublicKey(DEVNET_ESCROW_PROGRAM_ID);
export const MARKET_UUID = '00112233-4455-6677-8899-aabbccddeeff';
export const GENESIS_HASH = key(21).toBase58();
export const RECENT_BLOCKHASH = key(22).toBase58();
export const USER = keypair(23);
export const RELAYER = keypair(24);
export const USDC_MINT = key(25);

export const marketDocument: MarketDocumentV1 = {
  marketUuid: MARKET_UUID,
  fixtureId: 91_001n,
  claimSpecificationHash: hash(10),
  displayTermsHash: hash(11),
  asset: 'sol',
  probabilityPpm: 620_000,
  ratioMilli: 613,
  oddsMessageHash: hash(9),
  oddsTimestamp: 1_730_002_000n,
  inPlayStartTimestamp: 1_730_001_800n,
  activationDelaySeconds: 150n,
  positionCutoff: 1_730_003_600n,
  resolutionDeadline: 1_730_090_000n,
  feeBps: 0,
  oracleSetEpoch: 7n,
  replayFlag: false,
};

const common = {
  clusterGenesisHash: key(21).toBytes(),
  escrowProgramId: PROGRAM_ID.toBytes(),
  marketPda: deriveMarketPda(PROGRAM_ID, MARKET_UUID).publicKey.toBytes(),
  marketDocumentHash: hashMarketDocumentV1(marketDocument),
  fixtureId: marketDocument.fixtureId,
  oracleSetEpoch: marketDocument.oracleSetEpoch,
  issuedAt: 1_730_002_100n,
  expiresAt: 1_730_002_300n,
  evidenceHash: hash(31),
};

export const feedAttestation: FeedEventAttestationV1 = {
  ...common,
  eventKind: 'unfreeze',
  eventEpoch: 2n,
  decidingSequence: 500n,
  observedAt: 1_730_002_050n,
};

const lot = derivePositionLotPda(PROGRAM_ID, new PublicKey(common.marketPda), USER.publicKey, 4n);
export const invalidationAttestation: PositionInvalidationAttestationV1 = {
  ...common,
  positionLotPda: lot.publicKey.toBytes(),
  lotNonce: 4n,
  observedEventEpoch: 1n,
  invalidatedEventEpoch: 2n,
  decidingSequence: 501n,
};

export const settlementAttestation: SettlementAttestationV1 = {
  ...common,
  outcome: 'claim_won',
  decidingSequence: 502n,
  terminalPhase: 'F',
  regulationScore: { home: 2, away: 1 },
  fullMatchScore: { home: 2, away: 1 },
  evidenceSequenceCommitment: hash(32),
  normalizedEvidenceRoot: hash(33),
};

export const voidAttestation: VoidAttestationV1 = {
  ...common,
  reason: 'cancelled',
  decidingSequence: 503n,
};

export function sponsoredOptions(asset: 'sol' | 'usdc' = 'sol'): SponsoredPositionBuildOptions {
  return {
    programId: PROGRAM_ID,
    relayerFeePayer: RELAYER.publicKey,
    userWallet: USER.publicKey,
    canonicalUsdcMint: USDC_MINT,
    marketUuid: MARKET_UUID,
    marketDocumentHash: common.marketDocumentHash,
    side: 'back',
    amount: asset === 'sol' ? 50_000_000n : 25_000_000n,
    asset,
    expectedRatioMilli: 613,
    expectedEventEpoch: 1n,
    expectedLotNonce: 4n,
    expiresAt: 1_730_002_300n,
    genesisHash: GENESIS_HASH,
    recentBlockhash: RECENT_BLOCKHASH,
    lastValidBlockHeight: 5_000n,
  };
}

export function instructionRequests(): readonly EscrowInstructionRequest[] {
  const documentHash = hashMarketDocumentV1(marketDocument);
  return [
    { kind: 'initialize_config', initializer: key(1), configAuthority: key(2), pauseAuthority: key(3), marketCreationAuthority: key(4), feedOperatorAuthority: key(5), relayerFeePayer: key(6), clusterGenesisHash: key(21).toBytes(), canonicalUsdcMint: USDC_MINT, residualRecipient: key(7), minimumSolPosition: 1n, maximumSolPosition: 2n, minimumUsdcPosition: 3n, maximumUsdcPosition: 4n, maximumMarketDurationSeconds: 5n, maximumResolutionDelaySeconds: 6n, allowedTokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
    { kind: 'rotate_config', currentConfigAuthority: key(2), configAuthority: key(8), pauseAuthority: key(9), marketCreationAuthority: key(10), feedOperatorAuthority: key(11), relayerFeePayer: key(12), residualRecipient: key(13), minimumSolPosition: 1n, maximumSolPosition: 2n, minimumUsdcPosition: 3n, maximumUsdcPosition: 4n, maximumMarketDurationSeconds: 5n, maximumResolutionDelaySeconds: 6n },
    { kind: 'rotate_oracle_set', payer: key(1), configAuthority: key(2), currentOracleSet: PublicKey.default, epoch: 7n, signers: [key(3), key(4), key(5)], signatureThreshold: 2, activationSlot: 100n, retirementSlot: 200n },
    { kind: 'set_pause', authority: key(3), paused: true },
    { kind: 'initialize_market', payer: key(1), marketCreationAuthority: key(4), canonicalUsdcMint: USDC_MINT, expectedClusterGenesisHash: key(21).toBytes(), document: marketDocument, documentHash },
    { kind: 'freeze_market', feedOperatorAuthority: key(5), marketUuid: MARKET_UUID, expectedEventEpoch: 1n, evidenceHash: hash(31) },
    { kind: 'unfreeze_market', marketUuid: MARKET_UUID, attestation: feedAttestation },
    { kind: 'place_position', payer: RELAYER.publicKey, owner: USER.publicKey, canonicalUsdcMint: USDC_MINT, marketUuid: MARKET_UUID, side: 'back', amount: 50_000_000n, expectedAsset: 'sol', expectedRatioMilli: 613, expectedMarketDocumentHash: documentHash, expectedEventEpoch: 1n, expectedLotNonce: 4n, clientIntentHash: hash(30), clientExpiryTimestamp: 1_730_002_300n },
    { kind: 'activate_position_lot', marketUuid: MARKET_UUID, owner: USER.publicKey, lotNonce: 4n, expectedEventEpoch: 1n },
    { kind: 'invalidate_position_lot', marketUuid: MARKET_UUID, owner: USER.publicKey, lotNonce: 4n, attestation: invalidationAttestation },
    { kind: 'settle_market', marketUuid: MARKET_UUID, attestation: settlementAttestation },
    { kind: 'calculate_position_entitlement', marketUuid: MARKET_UUID, owner: USER.publicKey },
    { kind: 'void_market', marketUuid: MARKET_UUID, attestation: voidAttestation },
    { kind: 'timeout_void', marketUuid: MARKET_UUID },
    { kind: 'claim_position', marketUuid: MARKET_UUID, owner: USER.publicKey, asset: 'sol', canonicalUsdcMint: USDC_MINT },
    { kind: 'claim_position_for', payer: RELAYER.publicKey, marketUuid: MARKET_UUID, owner: USER.publicKey, asset: 'sol', canonicalUsdcMint: USDC_MINT },
    { kind: 'close_position_lots', marketUuid: MARKET_UUID, owner: USER.publicKey, rentRecipient: key(7), lotNonces: [5n, 4n] },
    { kind: 'close_position', marketUuid: MARKET_UUID, owner: USER.publicKey, rentRecipient: key(7) },
    { kind: 'close_market', marketUuid: MARKET_UUID, asset: 'sol', canonicalUsdcMint: USDC_MINT, residualRecipient: key(7) },
  ];
}
