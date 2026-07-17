import { ed25519 } from '@noble/curves/ed25519';
import { describe, expect, it } from 'vitest';
import { base58Encode, bytesToHex } from './codecs.js';
import {
  buildWalletLinkMessage,
  verifyWalletLinkSignature,
  type WalletLinkMessageInput,
} from './message-signing.js';

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PUBKEY = base58Encode(ed25519.getPublicKey(SEED));
const CHALLENGE: WalletLinkMessageInput = {
  webBaseUrl: 'https://called-it.example',
  telegramUserId: 123456789,
  pubkey: PUBKEY,
  cluster: 'mainnet-beta',
  nonce: 'RrJd6E4P9g4yFrYDutMb1LOkYTpctb6SqnVHTpUsqBE',
  issuedAt: '2026-07-13T12:00:00.000Z',
  expiresAt: '2026-07-13T12:05:00.000Z',
  challengeId: '970dc152-a274-41d1-a9e8-c1d84aa4dad0',
};

function builtBytes(): Uint8Array {
  const built = buildWalletLinkMessage(CHALLENGE);
  if (!built.ok) throw new Error(built.code);
  return built.bytes;
}

describe('wallet link messages', () => {
  it('builds a mainnet-bound canonical message', () => {
    const result = buildWalletLinkMessage(CHALLENGE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toContain('statement: Link this Solana mainnet wallet to Called It.');
    expect(result.message).toContain('cluster: mainnet-beta');
    expect(result.message).toContain(`telegram_user_id: ${CHALLENGE.telegramUserId}`);
    expect(result.message).toContain(`pubkey: ${PUBKEY}`);
  });

  it('verifies the wallet signature over exact canonical bytes', () => {
    const signatureHex = bytesToHex(ed25519.sign(builtBytes(), SEED));
    expect(verifyWalletLinkSignature(
      { pubkey: PUBKEY, signatureHex },
      CHALLENGE,
      new Date('2026-07-13T12:01:00.000Z'),
    )).toEqual({ ok: true });
  });

  it('rejects altered, expired, and malformed proofs', () => {
    const signatureHex = bytesToHex(ed25519.sign(builtBytes(), SEED));
    expect(verifyWalletLinkSignature(
      { pubkey: PUBKEY, signatureHex },
      { ...CHALLENGE, telegramUserId: CHALLENGE.telegramUserId + 1 },
      new Date('2026-07-13T12:01:00.000Z'),
    )).toEqual({ ok: false, code: 'signature_invalid' });
    expect(verifyWalletLinkSignature(
      { pubkey: PUBKEY, signatureHex },
      CHALLENGE,
      new Date(CHALLENGE.expiresAt),
    )).toEqual({ ok: false, code: 'challenge_expired' });
    expect(verifyWalletLinkSignature(
      { pubkey: PUBKEY, signatureHex: 'bad' },
      CHALLENGE,
      new Date('2026-07-13T12:01:00.000Z'),
    )).toEqual({ ok: false, code: 'invalid_signature' });
  });
});
