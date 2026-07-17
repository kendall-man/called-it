import {
  Ed25519Program,
  PublicKey,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  encodeSettlementAttestationV1,
  encodeVoidAttestationV1,
  type SettlementAttestationV1,
  type VoidAttestationV1,
} from './attestations.js';
import { publicKey, type PublicKeyInput } from './borsh.js';
import { CanonicalWriter, hashCanonicalBytes, writeDomain } from './codec.js';
import { deriveMarketPda } from './addresses.js';
import type { EscrowAsset, PositionSide } from './domain.js';
import { materializeInstruction, type PlacePositionInstruction } from './instructions.js';

export const POSITION_INTENT_DOMAIN_V1 = 'calledit.escrow.position-intent.v1';

export interface PositionIntentV1 {
  readonly escrowProgramId: PublicKeyInput;
  readonly marketPda: PublicKeyInput;
  readonly marketDocumentHash: Uint8Array;
  readonly userWallet: PublicKeyInput;
  readonly side: PositionSide;
  readonly amount: bigint;
  readonly asset: EscrowAsset;
  readonly expectedRatioMilli: number;
  readonly expectedEventEpoch: bigint;
  readonly expectedLotNonce: bigint;
  readonly expiresAt: bigint;
}

export function encodePositionIntentV1(intent: PositionIntentV1): Uint8Array {
  const writer = new CanonicalWriter();
  writeDomain(writer, POSITION_INTENT_DOMAIN_V1);
  writer
    .fixed(publicKey(intent.escrowProgramId).toBytes(), 32, 'escrow program ID')
    .fixed(publicKey(intent.marketPda).toBytes(), 32, 'market PDA')
    .fixed(intent.marketDocumentHash, 32, 'market document hash')
    .fixed(publicKey(intent.userWallet).toBytes(), 32, 'user wallet')
    .u8(intent.side === 'back' ? 0 : 1, 'position side')
    .u64(intent.amount, 'position amount')
    .u8(intent.asset === 'sol' ? 0 : 1, 'asset')
    .u32(intent.expectedRatioMilli, 'expected ratio milli')
    .u64(intent.expectedEventEpoch, 'expected event epoch')
    .u64(intent.expectedLotNonce, 'expected lot nonce')
    .i64(intent.expiresAt, 'intent expiry');
  return writer.finish();
}

export function hashPositionIntentV1(intent: PositionIntentV1): Uint8Array {
  return hashCanonicalBytes(encodePositionIntentV1(intent));
}

export interface BuildUnsignedV0TransactionOptions {
  readonly feePayer: PublicKeyInput;
  readonly recentBlockhash: string;
  readonly instructions: readonly TransactionInstruction[];
}

export function buildUnsignedV0Transaction(options: BuildUnsignedV0TransactionOptions): VersionedTransaction {
  if (options.instructions.length === 0) throw new RangeError('escrow transaction requires at least one instruction');
  const message = new TransactionMessage({
    payerKey: publicKey(options.feePayer),
    recentBlockhash: options.recentBlockhash,
    instructions: [...options.instructions],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export interface SponsoredPositionTerms {
  readonly programId: PublicKeyInput;
  readonly relayerFeePayer: PublicKeyInput;
  readonly userWallet: PublicKeyInput;
  readonly canonicalUsdcMint: PublicKeyInput;
  readonly marketUuid: string;
  readonly marketDocumentHash: Uint8Array;
  readonly side: PositionSide;
  readonly amount: bigint;
  readonly asset: EscrowAsset;
  readonly expectedRatioMilli: number;
  readonly expectedEventEpoch: bigint;
  readonly expectedLotNonce: bigint;
  readonly expiresAt: bigint;
}

export interface SponsoredPositionBuildOptions extends SponsoredPositionTerms {
  readonly genesisHash: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: bigint;
}

export interface SponsoredPositionTransaction {
  readonly transaction: VersionedTransaction;
  readonly instruction: TransactionInstruction;
  readonly intent: PositionIntentV1;
  readonly intentHash: Uint8Array;
  readonly genesisHash: string;
  readonly lastValidBlockHeight: bigint;
}

export function buildPositionInstruction(terms: SponsoredPositionTerms): {
  readonly instruction: TransactionInstruction;
  readonly intent: PositionIntentV1;
  readonly intentHash: Uint8Array;
} {
  const programId = publicKey(terms.programId);
  const userWallet = publicKey(terms.userWallet);
  const intent: PositionIntentV1 = {
    escrowProgramId: programId,
    marketPda: deriveMarketPda(programId, terms.marketUuid).publicKey,
    marketDocumentHash: terms.marketDocumentHash,
    userWallet,
    side: terms.side,
    amount: terms.amount,
    asset: terms.asset,
    expectedRatioMilli: terms.expectedRatioMilli,
    expectedEventEpoch: terms.expectedEventEpoch,
    expectedLotNonce: terms.expectedLotNonce,
    expiresAt: terms.expiresAt,
  };
  const intentHash = hashPositionIntentV1(intent);
  const request: PlacePositionInstruction = {
    kind: 'place_position', payer: terms.relayerFeePayer, owner: userWallet,
    canonicalUsdcMint: terms.canonicalUsdcMint, marketUuid: terms.marketUuid,
    side: terms.side, amount: terms.amount, expectedAsset: terms.asset,
    expectedRatioMilli: terms.expectedRatioMilli, expectedEventEpoch: terms.expectedEventEpoch,
    expectedMarketDocumentHash: terms.marketDocumentHash,
    expectedLotNonce: terms.expectedLotNonce, clientIntentHash: intentHash,
    clientExpiryTimestamp: terms.expiresAt,
  };
  return { instruction: materializeInstruction(request, { programId }), intent, intentHash };
}

export function buildSponsoredPositionTransaction(options: SponsoredPositionBuildOptions): SponsoredPositionTransaction {
  if (options.genesisHash.length === 0) throw new TypeError('genesis hash must not be empty');
  if (options.lastValidBlockHeight < 0n) throw new RangeError('last valid block height must be non-negative');
  if (publicKey(options.relayerFeePayer).equals(publicKey(options.userWallet))) {
    throw new TypeError('relayer fee payer and user wallet must be different keys');
  }
  const built = buildPositionInstruction(options);
  const transaction = buildUnsignedV0Transaction({
    feePayer: options.relayerFeePayer,
    recentBlockhash: options.recentBlockhash,
    instructions: [built.instruction],
  });
  return { ...built, transaction, genesisHash: options.genesisHash, lastValidBlockHeight: options.lastValidBlockHeight };
}

export function messageBytesForPrivy(transaction: VersionedTransaction): Uint8Array {
  return transaction.message.serialize();
}

export function applyPartialSignature(
  transaction: VersionedTransaction,
  signer: PublicKeyInput,
  signature: Uint8Array,
): void {
  if (signature.length !== 64) throw new RangeError('Ed25519 signature must be exactly 64 bytes');
  transaction.addSignature(publicKey(signer), signature);
}

export interface AttestationSignature {
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
}

export function buildAttestationVerificationInstructions(
  message: Uint8Array,
  signatures: readonly AttestationSignature[],
): readonly TransactionInstruction[] {
  if (message.length === 0) throw new RangeError('attestation message must not be empty');
  if (signatures.length === 0 || signatures.length > 3) {
    throw new RangeError('attestation must contain between one and three signatures');
  }
  if (message.length > 0xffff) throw new RangeError('attestation message exceeds Ed25519 offset limits');
  const seen = new Set<string>();
  for (const { publicKey: signer, signature } of signatures) {
    if (signer.length !== 32) throw new RangeError('attestation signer public key must be exactly 32 bytes');
    if (signature.length !== 64) throw new RangeError('attestation signature must be exactly 64 bytes');
    const key = Buffer.from(signer).toString('hex');
    if (seen.has(key)) throw new TypeError('attestation signer public keys must be distinct');
    seen.add(key);
  }

  const descriptorBytes = 14;
  const headerBytes = 2 + signatures.length * descriptorBytes;
  const signerPayloadBytes = 32 + 64;
  const messageOffset = headerBytes + signatures.length * signerPayloadBytes;
  const totalBytes = messageOffset + message.length;
  if (totalBytes > 0xffff) throw new RangeError('attestation verification instruction exceeds Ed25519 offset limits');

  const data = Buffer.alloc(totalBytes);
  data.writeUInt8(signatures.length, 0);
  data.writeUInt8(0, 1);
  signatures.forEach(({ publicKey: signer, signature }, index) => {
    const descriptorOffset = 2 + index * descriptorBytes;
    const publicKeyOffset = headerBytes + index * signerPayloadBytes;
    const signatureOffset = publicKeyOffset + 32;
    const selfInstructionIndex = 0xffff;
    for (const [offset, value] of [
      [descriptorOffset, signatureOffset],
      [descriptorOffset + 2, selfInstructionIndex],
      [descriptorOffset + 4, publicKeyOffset],
      [descriptorOffset + 6, selfInstructionIndex],
      [descriptorOffset + 8, messageOffset],
      [descriptorOffset + 10, message.length],
      [descriptorOffset + 12, selfInstructionIndex],
    ] as const) {
      data.writeUInt16LE(value, offset);
    }
    data.set(signer, publicKeyOffset);
    data.set(signature, signatureOffset);
  });
  data.set(message, messageOffset);

  return [new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  })];
}

export function buildSettlementAttestationVerificationInstructions(
  attestation: SettlementAttestationV1,
  signatures: readonly AttestationSignature[],
): readonly TransactionInstruction[] {
  return buildAttestationVerificationInstructions(encodeSettlementAttestationV1(attestation), signatures);
}

export function buildVoidAttestationVerificationInstructions(
  attestation: VoidAttestationV1,
  signatures: readonly AttestationSignature[],
): readonly TransactionInstruction[] {
  return buildAttestationVerificationInstructions(encodeVoidAttestationV1(attestation), signatures);
}
