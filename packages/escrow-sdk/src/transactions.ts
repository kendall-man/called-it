import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { CanonicalWriter, hashCanonicalBytes, writeDomain } from './codec.js';
import type { EscrowAsset, PositionSide } from './domain.js';

export const POSITION_INTENT_DOMAIN_V1 = 'calledit.escrow.position-intent.v1';

export interface PositionIntentV1 {
  readonly escrowProgramId: PublicKey | string;
  readonly marketPda: PublicKey | string;
  readonly marketDocumentHash: Uint8Array;
  readonly userWallet: PublicKey | string;
  readonly side: PositionSide;
  readonly amount: bigint;
  readonly asset: EscrowAsset;
  readonly expectedRatioMilli: number;
  readonly expectedEventEpoch: bigint;
  readonly expectedLotNonce: bigint;
  readonly expiresAt: bigint;
}

const key = (value: PublicKey | string) => typeof value === 'string' ? new PublicKey(value) : value;

export function encodePositionIntentV1(intent: PositionIntentV1): Uint8Array {
  const writer = new CanonicalWriter();
  writeDomain(writer, POSITION_INTENT_DOMAIN_V1);
  writer
    .fixed(key(intent.escrowProgramId).toBytes(), 32, 'escrow program ID')
    .fixed(key(intent.marketPda).toBytes(), 32, 'market PDA')
    .fixed(intent.marketDocumentHash, 32, 'market document hash')
    .fixed(key(intent.userWallet).toBytes(), 32, 'user wallet')
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
  readonly feePayer: PublicKey | string;
  readonly recentBlockhash: string;
  readonly instructions: readonly TransactionInstruction[];
}

/** Builds an unsigned v0 message; Privy/user signing remains outside this package. */
export function buildUnsignedV0Transaction(options: BuildUnsignedV0TransactionOptions): VersionedTransaction {
  if (options.instructions.length === 0) throw new Error('escrow transaction requires at least one instruction');
  const message = new TransactionMessage({
    payerKey: key(options.feePayer),
    recentBlockhash: options.recentBlockhash,
    instructions: [...options.instructions],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}
