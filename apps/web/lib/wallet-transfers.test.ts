import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import {
  formatSol,
  formatWalletAmount,
  parseSolAmount,
  parseWalletAmount,
  validateSignedTransaction,
} from './wallet-transfers';

describe('wallet transfer amount parsing', () => {
  it('uses exact decimal lamports without floating point rounding', () => {
    expect(parseSolAmount('0.001')).toBe(1_000_000n);
    expect(parseSolAmount('0.01')).toBe(10_000_000n);
    expect(parseSolAmount('1.000000001')).toBe(1_000_000_001n);
    expect(formatSol(1_000_000_001n)).toBe('1.000000001');
  });

  it('uses six exact decimals for USDC', () => {
    expect(parseWalletAmount('1', 'usdc')).toBe(1_000_000n);
    expect(parseWalletAmount('1.000001', 'usdc')).toBe(1_000_001n);
    expect(parseWalletAmount('0.0000001', 'usdc')).toBeNull();
    expect(formatWalletAmount(5_500_001n, 'usdc')).toBe('5.500001');
  });

  it('rejects zero, negative, malformed, and over-precise amounts', () => {
    expect(parseSolAmount('0')).toBeNull();
    expect(parseSolAmount('-1')).toBeNull();
    expect(parseSolAmount('0.0000000001')).toBeNull();
    expect(parseSolAmount('1e-3')).toBeNull();
  });
});

describe('Privy-signed wallet transfers', () => {
  it('accepts a signature only when the signed message is unchanged', () => {
    const signer = Keypair.generate();
    const destination = Keypair.generate().publicKey;
    const transaction = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: destination,
      lamports: 1_000_000,
    }));
    transaction.sign(signer);

    expect(() => validateSignedTransaction(transaction, transaction.serialize())).not.toThrow();
  });

  it('rejects a signed transaction whose transfer details changed', () => {
    const signer = Keypair.generate();
    const expected = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1_000_000,
    }));
    const changed = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: expected.recentBlockhash,
    }).add(SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 2_000_000,
    }));
    changed.sign(signer);

    expect(() => validateSignedTransaction(expected, changed.serialize())).toThrowError(
      'The wallet changed the transfer details.',
    );
  });
});
