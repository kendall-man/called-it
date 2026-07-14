import { Keypair, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { buildUnsignedV0Transaction } from '@calledit/escrow-sdk';
import { describe, expect, it } from 'vitest';
import {
  EscrowTransactionSignatureError,
  inspectUserSignedTransaction,
  sponsorTransaction,
} from './transaction-signatures.js';

const BLOCKHASH = '11111111111111111111111111111111';

function unsignedTransaction() {
  const sponsor = Keypair.generate();
  const owner = Keypair.generate();
  const instruction = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: sponsor.publicKey, isSigner: true, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from([1, 2, 3]),
  });
  return {
    sponsor,
    owner,
    transaction: buildUnsignedV0Transaction({
      feePayer: sponsor.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [instruction],
    }),
  };
}

describe('escrow sponsored transaction signatures', () => {
  it('preserves the sponsor signature while requiring Privy user authorization', () => {
    // Given a transaction whose fee payer and asset owner are separate signers
    const fixture = unsignedTransaction();
    const prepared = sponsorTransaction(fixture.transaction, fixture.sponsor);
    fixture.transaction.sign([fixture.owner]);

    // When the fully signed bytes return from Privy
    const verified = inspectUserSignedTransaction({
      rawTransactionBase64: Buffer.from(fixture.transaction.serialize()).toString('base64'),
      expectedMessageHashHex: prepared.messageHashHex,
      feePayer: fixture.sponsor.publicKey.toBase58(),
      owner: fixture.owner.publicKey.toBase58(),
    });

    // Then the exact message, transaction identity, and both signatures are proven
    expect(verified.messageHashHex).toBe(prepared.messageHashHex);
    expect(verified.expectedSignature).toBe(prepared.expectedSignature);
    expect(verified.recentBlockhash).toBe(BLOCKHASH);
  });

  it('rejects a tampered message and a missing user signature', () => {
    // Given sponsor-signed bytes with no user approval
    const fixture = unsignedTransaction();
    const prepared = sponsorTransaction(fixture.transaction, fixture.sponsor);
    const unsignedUserBytes = Buffer.from(fixture.transaction.serialize()).toString('base64');

    // When callback verification runs, then unsigned or substituted bytes fail closed
    expect(() => inspectUserSignedTransaction({
      rawTransactionBase64: unsignedUserBytes,
      expectedMessageHashHex: prepared.messageHashHex,
      feePayer: fixture.sponsor.publicKey.toBase58(),
      owner: fixture.owner.publicKey.toBase58(),
    })).toThrow(EscrowTransactionSignatureError);

    fixture.transaction.sign([fixture.owner]);
    expect(() => inspectUserSignedTransaction({
      rawTransactionBase64: Buffer.from(fixture.transaction.serialize()).toString('base64'),
      expectedMessageHashHex: '00'.repeat(32),
      feePayer: fixture.sponsor.publicKey.toBase58(),
      owner: fixture.owner.publicKey.toBase58(),
    })).toThrow('transaction_message_mismatch');
  });

  it('never permits the sponsor key to stand in for the user wallet', () => {
    // Given one wallet supplied for both custody authorization and sponsorship
    const fixture = unsignedTransaction();
    const prepared = sponsorTransaction(fixture.transaction, fixture.sponsor);

    // When ownership is checked, then signer-role confusion is rejected
    expect(() => inspectUserSignedTransaction({
      rawTransactionBase64: prepared.rawTransactionBase64,
      expectedMessageHashHex: prepared.messageHashHex,
      feePayer: fixture.sponsor.publicKey.toBase58(),
      owner: fixture.sponsor.publicKey.toBase58(),
    })).toThrow('user_and_sponsor_must_differ');
  });
});
