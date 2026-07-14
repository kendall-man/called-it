import { TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { publicKey } from './borsh.js';
import { buildPositionInstruction, type SponsoredPositionTerms } from './transactions.js';

export type EscrowVerificationErrorCode =
  | 'network_mismatch'
  | 'expired_blockhash'
  | 'stale_intent'
  | 'fee_payer_mismatch'
  | 'lookup_table_forbidden'
  | 'unexpected_instruction'
  | 'program_mismatch'
  | 'message_mismatch'
  | 'required_signer_mismatch'
  | 'missing_user_signature'
  | 'invalid_user_signature'
  | 'missing_relayer_signature'
  | 'invalid_relayer_signature';

export class EscrowTransactionVerificationError extends Error {
  readonly name = 'EscrowTransactionVerificationError';

  constructor(readonly code: EscrowVerificationErrorCode) {
    super(`escrow transaction verification failed: ${code}`);
  }
}

export interface SponsoredPositionVerificationOptions extends SponsoredPositionTerms {
  readonly expectedGenesisHash: string;
  readonly observedGenesisHash: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly currentBlockHeight: bigint;
  readonly currentUnixTimestamp: bigint;
  readonly requireRelayerSignature?: boolean;
}

function fail(code: EscrowVerificationErrorCode): never {
  throw new EscrowTransactionVerificationError(code);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function signatureIndex(transaction: VersionedTransaction, signer: ReturnType<typeof publicKey>): number {
  const count = transaction.message.header.numRequiredSignatures;
  return transaction.message.staticAccountKeys.slice(0, count).findIndex((key) => key.equals(signer));
}

function presentSignature(transaction: VersionedTransaction, index: number): Uint8Array {
  const signature = transaction.signatures[index];
  if (signature === undefined || signature.every((byte) => byte === 0)) fail('missing_user_signature');
  return signature;
}

async function validSignature(publicKeyBytes: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
  };
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    ownedBuffer(publicKeyBytes),
    'Ed25519',
    false,
    ['verify'],
  );
  return globalThis.crypto.subtle.verify(
    'Ed25519',
    key,
    ownedBuffer(signature),
    ownedBuffer(message),
  );
}

export async function verifySponsoredPositionTransaction(
  transaction: VersionedTransaction,
  options: SponsoredPositionVerificationOptions,
): Promise<void> {
  if (options.expectedGenesisHash.length === 0 || options.observedGenesisHash !== options.expectedGenesisHash) {
    fail('network_mismatch');
  }
  if (options.currentBlockHeight > options.lastValidBlockHeight) fail('expired_blockhash');
  if (options.currentUnixTimestamp > options.expiresAt) fail('stale_intent');
  if (transaction.message.addressTableLookups.length !== 0) fail('lookup_table_forbidden');

  const feePayer = publicKey(options.relayerFeePayer);
  const userWallet = publicKey(options.userWallet);
  if (!transaction.message.staticAccountKeys[0]?.equals(feePayer)) fail('fee_payer_mismatch');
  if (transaction.message.recentBlockhash !== options.recentBlockhash) fail('message_mismatch');

  const decompiled = TransactionMessage.decompile(transaction.message);
  if (decompiled.instructions.length !== 1) fail('unexpected_instruction');
  if (!decompiled.instructions[0]?.programId.equals(publicKey(options.programId))) fail('program_mismatch');

  const expectedInstruction = buildPositionInstruction(options).instruction;
  const expectedMessage = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: options.recentBlockhash,
    instructions: [expectedInstruction],
  }).compileToV0Message();
  if (!equalBytes(transaction.message.serialize(), expectedMessage.serialize())) fail('message_mismatch');

  const requiredSigners = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  if (requiredSigners.length !== 2 || !requiredSigners[0]?.equals(feePayer) || !requiredSigners[1]?.equals(userWallet)) {
    fail('required_signer_mismatch');
  }
  const message = transaction.message.serialize();
  const userIndex = signatureIndex(transaction, userWallet);
  if (userIndex < 0) fail('required_signer_mismatch');
  const userSignature = presentSignature(transaction, userIndex);
  if (!await validSignature(userWallet.toBytes(), userSignature, message)) fail('invalid_user_signature');

  if (options.requireRelayerSignature === true) {
    const relayerIndex = signatureIndex(transaction, feePayer);
    if (relayerIndex < 0) fail('required_signer_mismatch');
    const relayerSignature = transaction.signatures[relayerIndex];
    if (relayerSignature === undefined || relayerSignature.every((byte) => byte === 0)) fail('missing_relayer_signature');
    if (!await validSignature(feePayer.toBytes(), relayerSignature, message)) fail('invalid_relayer_signature');
  }
}
