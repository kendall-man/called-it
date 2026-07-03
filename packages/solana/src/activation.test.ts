import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair } from '@solana/web3.js';
import { activationMessage, signActivation } from './activation.js';

/** Deterministic wallet: seed bytes 0x01..0x20. */
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const WALLET = Keypair.fromSeed(SEED);
const JWT = 'test.jwt.token';
const TX_SIG = 'TESTSIG';

const ED25519_SIGNATURE_LEN = 64;

describe('activationMessage', () => {
  it('formats as `${txSig}:${leagues.join(",")}:${jwt}`', () => {
    expect(activationMessage(TX_SIG, [501, 804], JWT)).toBe('TESTSIG:501,804:test.jwt.token');
  });

  it('collapses empty leagues to a double colon', () => {
    expect(activationMessage(TX_SIG, [], JWT)).toBe('TESTSIG::test.jwt.token');
  });
});

describe('signActivation', () => {
  it('matches the precomputed format vector (ed25519 is deterministic)', () => {
    expect(signActivation(WALLET, TX_SIG, [501, 804], JWT)).toBe(
      'raFXwXJ5oJ6OnaagBbmhj3hbN03COBTiYJMECofw4AELhfJZIH3HHjT8qzZ/5dmTwqcJs9GN4EQb/cQ+mKB7Bg==',
    );
    expect(signActivation(WALLET, TX_SIG, [], JWT)).toBe(
      '9edlTtj9fFYcRLzxAUOWkiu1oTilIfjVDpd8rKjjoqt68U6SNh3Qyz+rcoVZJD614rRTZ6HPhPrV8AM7rnl7Ag==',
    );
  });

  it('emits base64 of a 64-byte detached signature', () => {
    const signature = Buffer.from(signActivation(WALLET, TX_SIG, [501], JWT), 'base64');
    expect(signature.length).toBe(ED25519_SIGNATURE_LEN);
  });

  it('verifies against the wallet pubkey with an independent ed25519 implementation', () => {
    const signature = Buffer.from(signActivation(WALLET, TX_SIG, [501, 804], JWT), 'base64');
    const message = Buffer.from(activationMessage(TX_SIG, [501, 804], JWT), 'utf8');
    expect(ed25519.verify(signature, message, WALLET.publicKey.toBytes())).toBe(true);
    // ...and only over that exact message.
    const other = Buffer.from(activationMessage(TX_SIG, [501], JWT), 'utf8');
    expect(ed25519.verify(signature, other, WALLET.publicKey.toBytes())).toBe(false);
  });

  it('signs identically from a freshly generated wallet (no seed dependence)', () => {
    const wallet = Keypair.generate();
    const signature = Buffer.from(signActivation(wallet, TX_SIG, [], JWT), 'base64');
    const message = Buffer.from(activationMessage(TX_SIG, [], JWT), 'utf8');
    expect(ed25519.verify(signature, message, wallet.publicKey.toBytes())).toBe(true);
  });
});
