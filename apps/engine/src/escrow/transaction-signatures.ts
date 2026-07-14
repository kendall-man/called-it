import { createHash, createPublicKey, verify } from 'node:crypto';
import { base58Encode } from '@calledit/solana';
import {
  PublicKey,
  VersionedTransaction,
  type Signer,
} from '@solana/web3.js';

export type EscrowTransactionSignatureErrorCode =
  | 'malformed_transaction'
  | 'invalid_signer_layout'
  | 'user_and_sponsor_must_differ'
  | 'transaction_message_mismatch'
  | 'sponsor_signature_missing'
  | 'sponsor_signature_invalid'
  | 'user_signature_missing'
  | 'user_signature_invalid';

export class EscrowTransactionSignatureError extends Error {
  readonly name = 'EscrowTransactionSignatureError';

  constructor(readonly code: EscrowTransactionSignatureErrorCode) {
    super(`escrow transaction signature rejected: ${code}`);
  }
}

export interface PreparedSponsoredTransaction {
  readonly rawTransactionBase64: string;
  readonly messageHashHex: string;
  readonly expectedSignature: string;
  readonly recentBlockhash: string;
}

export interface VerifiedUserTransaction extends PreparedSponsoredTransaction {}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function messageBytes(transaction: VersionedTransaction): Uint8Array {
  return transaction.message.serialize();
}

function messageHash(transaction: VersionedTransaction): string {
  return createHash('sha256').update(messageBytes(transaction)).digest('hex');
}

function signatureIsPresent(signature: Uint8Array): boolean {
  return signature.some((byte) => byte !== 0);
}

function verifySignature(
  transaction: VersionedTransaction,
  signerIndex: number,
  signer: PublicKey,
): boolean {
  const signature = transaction.signatures[signerIndex];
  if (signature === undefined || !signatureIsPresent(signature)) return false;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(signer.toBytes())]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, Buffer.from(messageBytes(transaction)), key, Buffer.from(signature));
}

function deserialize(rawTransactionBase64: string): VersionedTransaction {
  try {
    if (rawTransactionBase64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(rawTransactionBase64)) {
      throw new EscrowTransactionSignatureError('malformed_transaction');
    }
    return VersionedTransaction.deserialize(Buffer.from(rawTransactionBase64, 'base64'));
  } catch (error) {
    if (error instanceof EscrowTransactionSignatureError) throw error;
    if (error instanceof Error) {
      throw new EscrowTransactionSignatureError('malformed_transaction');
    }
    throw error;
  }
}

function signerIndex(transaction: VersionedTransaction, address: PublicKey): number {
  const required = transaction.message.header.numRequiredSignatures;
  return transaction.message.staticAccountKeys
    .slice(0, required)
    .findIndex((key) => key.equals(address));
}

export function sponsorTransaction(
  transaction: VersionedTransaction,
  sponsor: Signer,
): PreparedSponsoredTransaction {
  const sponsorIndex = signerIndex(transaction, sponsor.publicKey);
  if (sponsorIndex !== 0 || transaction.signatures.some(signatureIsPresent)) {
    throw new EscrowTransactionSignatureError('invalid_signer_layout');
  }
  transaction.sign([sponsor]);
  if (!verifySignature(transaction, sponsorIndex, sponsor.publicKey)) {
    throw new EscrowTransactionSignatureError('sponsor_signature_invalid');
  }
  const signature = transaction.signatures[sponsorIndex];
  if (signature === undefined) {
    throw new EscrowTransactionSignatureError('sponsor_signature_missing');
  }
  return {
    rawTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
    messageHashHex: messageHash(transaction),
    expectedSignature: base58Encode(signature),
    recentBlockhash: transaction.message.recentBlockhash,
  };
}

export function inspectUserSignedTransaction(input: {
  readonly rawTransactionBase64: string;
  readonly expectedMessageHashHex: string;
  readonly feePayer: string;
  readonly owner: string;
}): VerifiedUserTransaction {
  if (input.feePayer === input.owner) {
    throw new EscrowTransactionSignatureError('user_and_sponsor_must_differ');
  }
  const transaction = deserialize(input.rawTransactionBase64);
  const sponsor = new PublicKey(input.feePayer);
  const owner = new PublicKey(input.owner);
  const sponsorIndex = signerIndex(transaction, sponsor);
  const ownerIndex = signerIndex(transaction, owner);
  if (
    transaction.message.header.numRequiredSignatures !== 2 ||
    sponsorIndex !== 0 || ownerIndex !== 1
  ) {
    throw new EscrowTransactionSignatureError('invalid_signer_layout');
  }
  const observedMessageHashHex = messageHash(transaction);
  if (
    !/^[0-9a-fA-F]{64}$/.test(input.expectedMessageHashHex) ||
    observedMessageHashHex !== input.expectedMessageHashHex.toLowerCase()
  ) {
    throw new EscrowTransactionSignatureError('transaction_message_mismatch');
  }
  const sponsorSignature = transaction.signatures[sponsorIndex];
  if (sponsorSignature === undefined || !signatureIsPresent(sponsorSignature)) {
    throw new EscrowTransactionSignatureError('sponsor_signature_missing');
  }
  if (!verifySignature(transaction, sponsorIndex, sponsor)) {
    throw new EscrowTransactionSignatureError('sponsor_signature_invalid');
  }
  const ownerSignature = transaction.signatures[ownerIndex];
  if (ownerSignature === undefined || !signatureIsPresent(ownerSignature)) {
    throw new EscrowTransactionSignatureError('user_signature_missing');
  }
  if (!verifySignature(transaction, ownerIndex, owner)) {
    throw new EscrowTransactionSignatureError('user_signature_invalid');
  }
  return {
    rawTransactionBase64: input.rawTransactionBase64,
    messageHashHex: observedMessageHashHex,
    expectedSignature: base58Encode(sponsorSignature),
    recentBlockhash: transaction.message.recentBlockhash,
  };
}
