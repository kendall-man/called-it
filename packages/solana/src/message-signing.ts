import { ed25519 } from '@noble/curves/ed25519';
import { base58Decode } from './codecs.js';

export const WALLET_LINK_CLUSTER = 'devnet';
export const WALLET_LINK_STATEMENT = 'Link this Solana devnet wallet to Called It.';

const PUBKEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The trusted challenge fields that determine the exact bytes a wallet signs. */
export type WalletLinkMessageInput = {
  /** The configured `WEB_BASE_URL`, without a trailing slash. */
  readonly webBaseUrl: string;
  readonly telegramUserId: number;
  readonly pubkey: string;
  readonly cluster: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly challengeId: string;
};

export type WalletLinkClock = {
  readonly now: () => Date;
};

export type WalletLinkMessageFailureCode = 'invalid_challenge' | 'unsupported_cluster';

export type WalletLinkMessageResult =
  | { readonly ok: true; readonly message: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: WalletLinkMessageFailureCode };

export type WalletLinkSignatureVerificationFailureCode =
  | WalletLinkMessageFailureCode
  | 'invalid_clock'
  | 'challenge_expired'
  | 'invalid_payload'
  | 'invalid_pubkey'
  | 'invalid_signature'
  | 'pubkey_mismatch'
  | 'signature_invalid';

export type WalletLinkSignatureVerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: WalletLinkSignatureVerificationFailureCode };

type WalletLinkSignaturePayload = {
  readonly pubkey: string;
  readonly pubkeyBytes: Uint8Array;
  readonly signatureBytes: Uint8Array;
};

/**
 * Builds the only byte sequence accepted for a Called It Solana wallet link.
 * Callers must pass the resulting `bytes` directly to wallet `signMessage`.
 */
export function buildWalletLinkMessage(input: WalletLinkMessageInput): WalletLinkMessageResult {
  if (input.cluster !== WALLET_LINK_CLUSTER) {
    return { ok: false, code: 'unsupported_cluster' };
  }

  const issuedAtMs = canonicalIsoTimestamp(input.issuedAt);
  const expiresAtMs = canonicalIsoTimestamp(input.expiresAt);
  const pubkeyBytes = decodeBase58(input.pubkey, PUBKEY_LENGTH);
  if (
    !isWebBaseUrl(input.webBaseUrl) ||
    !Number.isSafeInteger(input.telegramUserId) ||
    input.telegramUserId <= 0 ||
    pubkeyBytes === null ||
    !isValidEd25519PublicKey(pubkeyBytes) ||
    !isSingleLine(input.nonce) ||
    issuedAtMs === null ||
    expiresAtMs === null ||
    expiresAtMs <= issuedAtMs ||
    !UUID_PATTERN.test(input.challengeId)
  ) {
    return { ok: false, code: 'invalid_challenge' };
  }

  const message = [
    `domain: ${input.webBaseUrl}`,
    `account: ${input.webBaseUrl}/account`,
    `statement: ${WALLET_LINK_STATEMENT}`,
    `telegram_user_id: ${input.telegramUserId}`,
    `pubkey: ${input.pubkey}`,
    `cluster: ${WALLET_LINK_CLUSTER}`,
    `nonce: ${input.nonce}`,
    `issued_at: ${input.issuedAt}`,
    `expires_at: ${input.expiresAt}`,
    `challenge_id: ${input.challengeId}`,
  ].join('\n');

  return { ok: true, message, bytes: new TextEncoder().encode(message) };
}

/**
 * Parses an untrusted transport payload, checks expiry against the injected
 * clock, and verifies the signature over bytes rebuilt from the trusted
 * challenge. It never verifies caller-provided message text.
 */
export function verifyWalletLinkSignature(
  rawPayload: unknown,
  challenge: WalletLinkMessageInput,
  clock: WalletLinkClock,
): WalletLinkSignatureVerificationResult {
  const message = buildWalletLinkMessage(challenge);
  if (!message.ok) return message;

  const nowMs = clock.now().getTime();
  if (!Number.isFinite(nowMs)) return { ok: false, code: 'invalid_clock' };

  const expiresAtMs = canonicalIsoTimestamp(challenge.expiresAt);
  if (expiresAtMs === null || expiresAtMs <= nowMs) {
    return { ok: false, code: 'challenge_expired' };
  }

  const payload = parseSignaturePayload(rawPayload);
  if (!payload.ok) return payload;
  if (payload.value.pubkey !== challenge.pubkey) {
    return { ok: false, code: 'pubkey_mismatch' };
  }

  try {
    return ed25519.verify(payload.value.signatureBytes, message.bytes, payload.value.pubkeyBytes)
      ? { ok: true }
      : { ok: false, code: 'signature_invalid' };
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: 'signature_invalid' };
    throw error;
  }
}

function parseSignaturePayload(
  rawPayload: unknown,
):
  | { readonly ok: true; readonly value: WalletLinkSignaturePayload }
  | { readonly ok: false; readonly code: 'invalid_payload' | 'invalid_pubkey' | 'invalid_signature' } {
  if (!isRecord(rawPayload)) return { ok: false, code: 'invalid_payload' };

  const { pubkey, signature } = rawPayload;
  if (typeof pubkey !== 'string' || typeof signature !== 'string') {
    return { ok: false, code: 'invalid_payload' };
  }

  const pubkeyBytes = decodeBase58(pubkey, PUBKEY_LENGTH);
  if (pubkeyBytes === null || !isValidEd25519PublicKey(pubkeyBytes)) {
    return { ok: false, code: 'invalid_pubkey' };
  }

  const signatureBytes = decodeBase58(signature, SIGNATURE_LENGTH);
  if (signatureBytes === null) return { ok: false, code: 'invalid_signature' };

  return { ok: true, value: { pubkey, pubkeyBytes, signatureBytes } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase58(value: string, expectedLength: number): Uint8Array | null {
  try {
    const decoded = base58Decode(value);
    return decoded.length === expectedLength ? decoded : null;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

function isValidEd25519PublicKey(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function isWebBaseUrl(value: string): boolean {
  if (!isSingleLine(value) || value.endsWith('/')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.pathname === '/' && url.search === '' && url.hash === '';
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function isSingleLine(value: string): boolean {
  return value.length > 0 && value.trim() === value && !/[\r\n]/.test(value);
}

function canonicalIsoTimestamp(value: string): number | null {
  if (!isSingleLine(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? timestamp : null;
}
