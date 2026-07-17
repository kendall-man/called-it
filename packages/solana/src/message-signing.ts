import { ed25519 } from '@noble/curves/ed25519';
import { base58Decode, hexToBytes } from './codecs.js';

export type WalletLinkCluster = 'devnet' | 'mainnet-beta';

const PUBKEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WalletLinkMessageInput {
  readonly webBaseUrl: string;
  readonly telegramUserId: number;
  readonly pubkey: string;
  readonly cluster: WalletLinkCluster;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly challengeId: string;
}

export type WalletLinkMessageResult =
  | { readonly ok: true; readonly message: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: 'invalid_challenge' };

export type WalletLinkVerificationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'invalid_challenge'
        | 'challenge_expired'
        | 'invalid_payload'
        | 'invalid_pubkey'
        | 'invalid_signature'
        | 'pubkey_mismatch'
        | 'signature_invalid';
    };

export function buildWalletLinkMessage(input: WalletLinkMessageInput): WalletLinkMessageResult {
  const issuedAtMs = canonicalIsoTimestamp(input.issuedAt);
  const expiresAtMs = canonicalIsoTimestamp(input.expiresAt);
  const pubkeyBytes = decodePubkey(input.pubkey);
  if (
    !isWebOrigin(input.webBaseUrl) ||
    !Number.isSafeInteger(input.telegramUserId) ||
    input.telegramUserId <= 0 ||
    pubkeyBytes === null ||
    !isSingleLine(input.nonce) ||
    issuedAtMs === null ||
    expiresAtMs === null ||
    expiresAtMs <= issuedAtMs ||
    !UUID_PATTERN.test(input.challengeId)
  ) {
    return { ok: false, code: 'invalid_challenge' };
  }

  const networkLabel = input.cluster === 'mainnet-beta' ? 'mainnet' : 'devnet';
  const message = [
    `domain: ${input.webBaseUrl}`,
    `account: ${input.webBaseUrl}/wallet`,
    `statement: Link this Solana ${networkLabel} wallet to Called It.`,
    `telegram_user_id: ${input.telegramUserId}`,
    `pubkey: ${input.pubkey}`,
    `cluster: ${input.cluster}`,
    `nonce: ${input.nonce}`,
    `issued_at: ${input.issuedAt}`,
    `expires_at: ${input.expiresAt}`,
    `challenge_id: ${input.challengeId}`,
  ].join('\n');
  return { ok: true, message, bytes: new TextEncoder().encode(message) };
}

export function verifyWalletLinkSignature(
  rawPayload: unknown,
  challenge: WalletLinkMessageInput,
  now: Date,
): WalletLinkVerificationResult {
  const message = buildWalletLinkMessage(challenge);
  if (!message.ok) return message;
  if (Date.parse(challenge.expiresAt) <= now.getTime()) {
    return { ok: false, code: 'challenge_expired' };
  }
  if (!isRecord(rawPayload)) return { ok: false, code: 'invalid_payload' };
  const { pubkey, signatureHex } = rawPayload;
  if (typeof pubkey !== 'string' || typeof signatureHex !== 'string') {
    return { ok: false, code: 'invalid_payload' };
  }
  const pubkeyBytes = decodePubkey(pubkey);
  if (pubkeyBytes === null) return { ok: false, code: 'invalid_pubkey' };
  if (!/^[0-9a-f]{128}$/i.test(signatureHex)) {
    return { ok: false, code: 'invalid_signature' };
  }
  const signature = hexToBytes(signatureHex);
  if (signature.length !== SIGNATURE_LENGTH) {
    return { ok: false, code: 'invalid_signature' };
  }
  if (pubkey !== challenge.pubkey) return { ok: false, code: 'pubkey_mismatch' };
  try {
    return ed25519.verify(signature, message.bytes, pubkeyBytes)
      ? { ok: true }
      : { ok: false, code: 'signature_invalid' };
  } catch {
    return { ok: false, code: 'signature_invalid' };
  }
}

function decodePubkey(value: string): Uint8Array | null {
  try {
    const bytes = base58Decode(value);
    if (bytes.length !== PUBKEY_LENGTH) return null;
    ed25519.ExtendedPoint.fromHex(bytes);
    return bytes;
  } catch {
    return null;
  }
}

function canonicalIsoTimestamp(value: string): number | null {
  if (!isSingleLine(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? timestamp : null;
}

function isWebOrigin(value: string): boolean {
  if (!isSingleLine(value) || value.endsWith('/')) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isSingleLine(value: string): boolean {
  return value.length > 0 && value.trim() === value && !/[\r\n]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
