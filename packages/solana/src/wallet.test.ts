import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { base58Encode } from './codecs.js';
import { loadWallet } from './wallet.js';

describe('loadWallet', () => {
  it('loads a full 64-byte base58 secret key', () => {
    const keypair = Keypair.generate();
    const loaded = loadWallet(base58Encode(keypair.secretKey));
    expect(loaded.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
  });

  it('loads a 32-byte seed', () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const expected = Keypair.fromSeed(seed);
    const loaded = loadWallet(base58Encode(seed));
    expect(loaded.publicKey.toBase58()).toBe(expected.publicKey.toBase58());
  });

  it('trims surrounding whitespace (as pasted from .env)', () => {
    const keypair = Keypair.generate();
    const loaded = loadWallet(`  ${base58Encode(keypair.secretKey)}\n`);
    expect(loaded.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
  });

  it('fails loudly on empty, malformed, and wrong-length input', () => {
    expect(() => loadWallet('')).toThrow(/SOLANA_KEYPAIR_B58/);
    expect(() => loadWallet('not base58 0OIl')).toThrow(/base58/);
    expect(() => loadWallet(base58Encode(Uint8Array.of(1, 2, 3)))).toThrow(/3 bytes/);
  });
});
