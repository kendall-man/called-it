import { PublicKey } from '@solana/web3.js';
import {
  hashSettlementAttestationV1,
} from './attestations.js';
import { BorshWriter, publicKey } from './borsh.js';
import { assertInteger, bytesToHex, uuidToBytes } from './codec.js';
import { hashMarketDocumentV1 } from './domain.js';
import { deriveOracleSetPda, deriveProtocolConfigPda } from './addresses.js';
import type { EscrowInstructionRequest } from './instruction-types.js';
import { ESCROW_INSTRUCTION_DISCRIMINATORS } from './schema.js';

const assetTag = (asset: 'sol' | 'usdc'): number => asset === 'sol' ? 0 : 1;
const sideTag = (side: 'back' | 'doubt'): number => side === 'back' ? 0 : 1;

function discriminator(kind: EscrowInstructionRequest['kind']): Uint8Array {
  return Uint8Array.from(ESCROW_INSTRUCTION_DISCRIMINATORS[kind]);
}

function encodeInitializeConfig(request: Extract<EscrowInstructionRequest, { kind: 'initialize_config' }>): Uint8Array {
  return new BorshWriter()
    .fixed(request.clusterGenesisHash, 32, 'cluster genesis hash')
    .publicKey(request.configAuthority)
    .publicKey(request.pauseAuthority)
    .publicKey(request.marketCreationAuthority)
    .publicKey(request.feedOperatorAuthority)
    .publicKey(request.relayerFeePayer)
    .publicKey(request.residualRecipient)
    .publicKey(request.canonicalUsdcMint)
    .publicKey(request.allowedTokenProgram)
    .u64(request.maximumSolPosition, 'maximum SOL position')
    .u64(request.maximumUsdcPosition, 'maximum USDC position')
    .u64(request.minimumSolPosition, 'minimum SOL position')
    .u64(request.minimumUsdcPosition, 'minimum USDC position')
    .u64(request.maximumMarketDurationSeconds, 'maximum market duration')
    .u64(request.maximumResolutionDelaySeconds, 'maximum resolution delay')
    .finish();
}

function encodeInitializeMarket(
  request: Extract<EscrowInstructionRequest, { kind: 'initialize_market' }>,
  programId: PublicKey,
): Uint8Array {
  const document = request.document;
  if (bytesToHex(hashMarketDocumentV1(document)) !== bytesToHex(request.documentHash)) {
    throw new TypeError('market document hash does not match the canonical document');
  }
  const tokenMint = document.asset === 'usdc' ? publicKey(request.canonicalUsdcMint) : PublicKey.default;
  return new BorshWriter()
    .fixed(request.expectedClusterGenesisHash, 32, 'expected cluster genesis hash')
    .publicKey(programId)
    .publicKey(deriveProtocolConfigPda(programId).publicKey)
    .publicKey(deriveOracleSetPda(programId, document.oracleSetEpoch).publicKey)
    .fixed(uuidToBytes(document.marketUuid), 16, 'market UUID')
    .u64(document.fixtureId, 'fixture ID')
    .fixed(document.claimSpecificationHash, 32, 'claim specification hash')
    .fixed(document.displayTermsHash, 32, 'display terms hash')
    .fixed(document.oddsMessageHash, 32, 'odds source message hash')
    .fixed(request.documentHash, 32, 'market document hash')
    .i64(document.oddsTimestamp, 'quote timestamp')
    .u32(document.probabilityPpm, 'probability PPM')
    .u32(document.ratioMilli, 'ratio milli')
    .u8(assetTag(document.asset), 'asset')
    .publicKey(tokenMint)
    .u16(document.feeBps, 'fee basis points')
    .bool(document.replayFlag, 'replay')
    .i64(document.inPlayStartTimestamp, 'in-play start timestamp')
    .u64(document.activationDelaySeconds, 'activation delay seconds')
    .i64(document.positionCutoff, 'position cutoff timestamp')
    .i64(document.resolutionDeadline, 'resolution deadline')
    .u64(document.oracleSetEpoch, 'oracle-set epoch')
    .finish();
}

function encodeRequestArgs(request: EscrowInstructionRequest, programId: PublicKey): Uint8Array {
  switch (request.kind) {
    case 'initialize_config': return encodeInitializeConfig(request);
    case 'rotate_config': return new BorshWriter()
      .publicKey(request.configAuthority).publicKey(request.pauseAuthority)
      .publicKey(request.marketCreationAuthority).publicKey(request.feedOperatorAuthority)
      .publicKey(request.relayerFeePayer).publicKey(request.residualRecipient)
      .u64(request.maximumSolPosition, 'maximum SOL position')
      .u64(request.maximumUsdcPosition, 'maximum USDC position')
      .u64(request.minimumSolPosition, 'minimum SOL position')
      .u64(request.minimumUsdcPosition, 'minimum USDC position')
      .u64(request.maximumMarketDurationSeconds, 'maximum market duration')
      .u64(request.maximumResolutionDelaySeconds, 'maximum resolution delay').finish();
    case 'rotate_oracle_set': return new BorshWriter()
      .u64(request.epoch, 'oracle-set epoch')
      .publicKeyVector(request.signers, 'oracle signers')
      .u8(request.signatureThreshold, 'signature threshold')
      .u64(request.activationSlot, 'activation slot')
      .optionU64(request.retirementSlot, 'retirement slot')
      .finish();
    case 'set_pause': return new BorshWriter().bool(request.paused, 'paused').finish();
    case 'initialize_market': return encodeInitializeMarket(request, programId);
    case 'freeze_market': return new BorshWriter()
      .u64(request.expectedEventEpoch, 'expected event epoch')
      .fixed(request.evidenceHash, 32, 'evidence hash').finish();
    case 'unfreeze_market': return new BorshWriter()
      .u64(request.attestation.eventEpoch - 1n, 'expected event epoch')
      .u64(request.attestation.decidingSequence, 'deciding sequence')
      .i64(request.attestation.observedAt, 'observed timestamp')
      .i64(request.attestation.issuedAt, 'issued timestamp')
      .i64(request.attestation.expiresAt, 'expiry timestamp')
      .fixed(request.attestation.evidenceHash, 32, 'evidence hash').finish();
    case 'place_position': return new BorshWriter()
      .fixed(uuidToBytes(request.marketUuid), 16, 'market UUID')
      .u8(sideTag(request.side), 'position side')
      .u64(request.amount, 'position amount')
      .u8(assetTag(request.expectedAsset), 'expected asset')
      .u32(request.expectedRatioMilli, 'expected ratio milli')
      .fixed(request.expectedMarketDocumentHash, 32, 'expected market document hash')
      .u64(request.expectedEventEpoch, 'expected event epoch')
      .u64(request.expectedLotNonce, 'expected lot nonce')
      .fixed(request.clientIntentHash, 32, 'client intent hash')
      .i64(request.clientExpiryTimestamp, 'client expiry timestamp').finish();
    case 'activate_position_lot': return new BorshWriter()
      .u64(request.lotNonce, 'lot nonce')
      .u64(request.expectedEventEpoch, 'expected event epoch').finish();
    case 'invalidate_position_lot': return new BorshWriter()
      .u64(request.lotNonce, 'lot nonce')
      .fixed(request.attestation.evidenceHash, 32, 'evidence hash')
      .u64(request.attestation.invalidatedEventEpoch, 'invalidated event epoch')
      .u64(request.attestation.decidingSequence, 'deciding sequence')
      .i64(request.attestation.issuedAt, 'issued timestamp')
      .i64(request.attestation.expiresAt, 'expiry timestamp').finish();
    case 'settle_market': return new BorshWriter()
      .u8(request.attestation.outcome === 'claim_won' ? 1 : 2, 'settlement outcome')
      .u64(request.attestation.decidingSequence, 'deciding sequence')
      .fixed(request.attestation.evidenceHash, 32, 'evidence hash')
      .fixed(hashSettlementAttestationV1(request.attestation), 32, 'evidence commitment')
      .i64(request.attestation.expiresAt, 'attestation expiry timestamp').finish();
    case 'void_market': return new BorshWriter()
      .fixed(request.attestation.evidenceHash, 32, 'evidence hash')
      .i64(request.attestation.expiresAt, 'attestation expiry timestamp').finish();
    case 'close_position_lots': return new BorshWriter()
      .u64Vector(request.lotNonces, 'lot nonces').finish();
    case 'calculate_position_entitlement':
    case 'timeout_void':
    case 'claim_position':
    case 'close_market': return new Uint8Array();
  }
}

export function encodeEscrowInstructionData(request: EscrowInstructionRequest, programId: PublicKey): Uint8Array {
  const args = encodeRequestArgs(request, programId);
  const output = new Uint8Array(8 + args.length);
  output.set(discriminator(request.kind));
  output.set(args, 8);
  return output;
}

export function assertOracleSignerSet(signers: readonly unknown[], threshold: number): void {
  assertInteger(threshold, 'signature threshold', 1, 3);
  if (signers.length !== 3) throw new RangeError('V1 oracle set must contain exactly 3 signers');
  if (threshold !== 2) throw new RangeError('V1 oracle signature threshold must be 2');
}
