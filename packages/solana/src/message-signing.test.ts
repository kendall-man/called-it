import { ed25519 } from '@noble/curves/ed25519';
import { describe, expect, it } from 'vitest';
import { base58Encode } from './codecs.js';
import {
  buildWalletLinkMessage,
  verifyWalletLinkSignature,
  type WalletLinkMessageInput,
} from './message-signing.js';

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PUBLIC_KEY = base58Encode(ed25519.getPublicKey(SEED));
const CLOCK = { now: () => new Date('2026-07-11T12:02:00.000Z') };

const CHALLENGE: WalletLinkMessageInput = {
  webBaseUrl: 'https://called.example.test',
  telegramUserId: 123_456_789,
  pubkey: PUBLIC_KEY,
  cluster: 'devnet',
  nonce: '6wfZVsbazn64ZPuvKzHqQpK3PvCpvN9SkMMm36BcCy84',
  issuedAt: '2026-07-11T12:00:00.000Z',
  expiresAt: '2026-07-11T12:05:00.000Z',
  challengeId: '970dc152-a274-41d1-a9e8-c1d84aa4dad0',
};

function canonicalBytes(input: WalletLinkMessageInput = CHALLENGE): Uint8Array {
  const result = buildWalletLinkMessage(input);
  if (result.ok) return result.bytes;
  throw new Error(`expected valid message input, received ${result.code}`);
}

function signedPayload(bytes: Uint8Array): { readonly pubkey: string; readonly signature: string } {
  return {
    pubkey: PUBLIC_KEY,
    signature: base58Encode(ed25519.sign(bytes, SEED)),
  };
}

function alterLine(bytes: Uint8Array, expected: string, replacement: string): Uint8Array {
  const message = new TextDecoder().decode(bytes);
  expect(message).toContain(expected);
  return new TextEncoder().encode(message.replace(expected, replacement));
}

describe('buildWalletLinkMessage', () => {
  it('constructs the canonical LF-delimited UTF-8 wallet-link message', () => {
    // Given a valid devnet wallet-link challenge
    const result = buildWalletLinkMessage(CHALLENGE);

    // When its canonical message is constructed

    // Then every bound field appears in the fixed protocol order
    expect(result).toEqual({
      ok: true,
      message: [
        'domain: https://called.example.test',
        'account: https://called.example.test/account',
        'statement: Link this Solana devnet wallet to Called It.',
        'telegram_user_id: 123456789',
        `pubkey: ${PUBLIC_KEY}`,
        'cluster: devnet',
        'nonce: 6wfZVsbazn64ZPuvKzHqQpK3PvCpvN9SkMMm36BcCy84',
        'issued_at: 2026-07-11T12:00:00.000Z',
        'expires_at: 2026-07-11T12:05:00.000Z',
        'challenge_id: 970dc152-a274-41d1-a9e8-c1d84aa4dad0',
      ].join('\n'),
      bytes: canonicalBytes(),
    });
  });

  it('accepts only the devnet cluster', () => {
    // Given a challenge configured for a different Solana cluster
    const input = { ...CHALLENGE, cluster: 'mainnet-beta' };

    // When its message is constructed
    const result = buildWalletLinkMessage(input);

    // Then construction returns the typed cluster failure
    expect(result).toEqual({ ok: false, code: 'unsupported_cluster' });
  });
});

describe('verifyWalletLinkSignature', () => {
  it('accepts a generated valid Ed25519 signature over the canonical bytes', () => {
    // Given a Solana public key and valid signature generated from the canonical bytes
    const payload = signedPayload(canonicalBytes());

    // When the raw payload is parsed and verified against the trusted challenge
    const result = verifyWalletLinkSignature(payload, CHALLENGE, CLOCK);

    // Then the deterministic signature vector and linked wallet ownership proof are valid
    expect(payload.signature).toBe(
      '2uj9bPsgTYs3zSwAUVBfR8LTdMcQ5bz2Wr7EkVARZNMeqhkKPMFQUYFzUVCatyu1rPRi2NGuBp136aLAxeQ2ufV3',
    );
    expect(result).toEqual({ ok: true });
  });

  it.each([
    ['domain', 'domain: https://called.example.test', 'domain: https://attacker.example.test'],
    ['account URL', 'account: https://called.example.test/account', 'account: https://called.example.test/other'],
    ['statement', 'statement: Link this Solana devnet wallet to Called It.', 'statement: Link this wallet elsewhere.'],
    ['Telegram user ID', 'telegram_user_id: 123456789', 'telegram_user_id: 123456790'],
    ['pubkey', `pubkey: ${PUBLIC_KEY}`, `pubkey: ${base58Encode(ed25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 2)))}`],
    ['cluster', 'cluster: devnet', 'cluster: mainnet-beta'],
    ['nonce', 'nonce: 6wfZVsbazn64ZPuvKzHqQpK3PvCpvN9SkMMm36BcCy84', 'nonce: changed-nonce'],
    ['issued timestamp', 'issued_at: 2026-07-11T12:00:00.000Z', 'issued_at: 2026-07-11T12:01:00.000Z'],
    ['expiry timestamp', 'expires_at: 2026-07-11T12:05:00.000Z', 'expires_at: 2026-07-11T12:06:00.000Z'],
    ['challenge ID', 'challenge_id: 970dc152-a274-41d1-a9e8-c1d84aa4dad0', 'challenge_id: 59d9837a-f83c-48c1-94f6-835aad373bd4'],
  ])('rejects a valid signature over an altered %s', (_field, expected, replacement) => {
    // Given a signature over bytes altered from the trusted canonical challenge
    const altered = alterLine(canonicalBytes(), expected, replacement);
    const payload = signedPayload(altered);

    // When the verifier rebuilds the trusted canonical bytes
    const result = verifyWalletLinkSignature(payload, CHALLENGE, CLOCK);

    // Then the byte drift is rejected as an invalid signature
    expect(result).toEqual({ ok: false, code: 'signature_invalid' });
  });

  it('rejects expiry at the injected clock boundary', () => {
    // Given a valid signature and a clock at the challenge expiry instant
    const payload = signedPayload(canonicalBytes());
    const clock = { now: () => new Date(CHALLENGE.expiresAt) };

    // When the verifier checks the challenge
    const result = verifyWalletLinkSignature(payload, CHALLENGE, clock);

    // Then expiry is exclusive
    expect(result).toEqual({ ok: false, code: 'challenge_expired' });
  });

  it.each([
    ['not an object', null, 'invalid_payload'],
    ['missing signature', { pubkey: PUBLIC_KEY }, 'invalid_payload'],
    ['malformed pubkey', { pubkey: '0OIl', signature: 'abc' }, 'invalid_pubkey'],
    ['31-byte pubkey', { pubkey: base58Encode(new Uint8Array(31)), signature: 'abc' }, 'invalid_pubkey'],
    ['63-byte signature', { pubkey: PUBLIC_KEY, signature: base58Encode(new Uint8Array(63)) }, 'invalid_signature'],
    ['65-byte signature', { pubkey: PUBLIC_KEY, signature: base58Encode(new Uint8Array(65)) }, 'invalid_signature'],
    ['malformed signature', { pubkey: PUBLIC_KEY, signature: '0OIl' }, 'invalid_signature'],
  ])('rejects a payload with %s', (_reason, payload, code) => {
    // Given an untrusted malformed signature payload

    // When the verifier parses it at its boundary
    const result = verifyWalletLinkSignature(payload, CHALLENGE, CLOCK);

    // Then it returns a typed failure without attempting verification
    expect(result).toEqual({ ok: false, code });
  });

  it('rejects a well-formed signature payload for a different public key', () => {
    // Given a validly encoded public key that does not match the challenge wallet
    const payload = {
      ...signedPayload(canonicalBytes()),
      pubkey: base58Encode(ed25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 2))),
    };

    // When the verifier checks the expected challenge binding
    const result = verifyWalletLinkSignature(payload, CHALLENGE, CLOCK);

    // Then it rejects the mismatched public key before accepting the signature
    expect(result).toEqual({ ok: false, code: 'pubkey_mismatch' });
  });
});
