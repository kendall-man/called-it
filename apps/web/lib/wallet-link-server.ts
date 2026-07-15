import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  buildWalletLinkMessage,
  verifyWalletLinkSignature,
  type WalletLinkMessageInput,
} from '@calledit/solana/message-signing';
import { z } from 'zod';
import { loadWebEnv } from './env';
import {
  isPrivySessionOwner,
  PrivyIdentityError,
  verifyPrivyWalletIdentity,
  type PrivyIdentityVerifier,
  type PrivyWalletIdentity,
} from './privy-server';

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const CHALLENGE_TTL_MS = 5 * 60_000;

export const WalletChallengeRequestSchema = z.object({
  token: z.string().regex(SESSION_TOKEN_PATTERN),
  pubkey: z.string().regex(PUBKEY_PATTERN),
}).strict();

export const WalletVerificationRequestSchema = WalletChallengeRequestSchema.extend({
  challengeId: z.string().uuid(),
  signatureHex: z.string().regex(/^[0-9a-f]{128}$/i),
}).strict();

export interface WalletApiResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function walletSessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function walletChallengeNonce(token: string, challengeId: string): string {
  return createHash('sha256')
    .update('called-it-wallet-challenge\0')
    .update(token)
    .update('\0')
    .update(challengeId)
    .digest('base64url');
}

export async function createWalletChallenge(
  raw: unknown,
  accessToken: string,
  verifyIdentity: PrivyIdentityVerifier = verifyPrivyWalletIdentity,
): Promise<WalletApiResult> {
  const input = WalletChallengeRequestSchema.safeParse(raw);
  if (!input.success) return refusal(400, 'invalid_request');
  const identity = await privyIdentity(accessToken, input.data.pubkey, verifyIdentity);
  if (isApiResult(identity)) return identity;
  const env = walletEnv();
  const client = walletClient(env);
  const challengeId = randomUUID();
  const nonce = walletChallengeNonce(input.data.token, challengeId);
  const challengeHashHex = createHash('sha256').update(nonce).digest('hex');
  const requestedExpiry = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  const { data, error } = await client.rpc('wager_create_wallet_link_challenge', {
    p_token_hash_hex: walletSessionTokenHash(input.data.token),
    p_challenge_id: challengeId,
    p_pubkey: input.data.pubkey,
    p_challenge_hash_hex: challengeHashHex,
    p_expires_at: requestedExpiry,
  });
  if (error !== null) return refusal(503, 'wallet_service_unavailable');
  const result = record(data);
  if (result?.ok !== true) return refusal(410, 'wallet_link_expired');
  const userId = safePositiveInteger(result.user_id);
  const issuedAt = canonicalTimestamp(result.issued_at);
  const expiresAt = canonicalTimestamp(result.expires_at);
  if (userId === null || issuedAt === null || expiresAt === null) {
    return refusal(503, 'wallet_service_unavailable');
  }
  if (!isPrivySessionOwner(identity, userId)) {
    return refusal(403, 'privy_identity_invalid');
  }
  const challenge: WalletLinkMessageInput = {
    webBaseUrl: new URL(env.WEB_BASE_URL).origin,
    telegramUserId: userId,
    pubkey: input.data.pubkey,
    cluster: env.NEXT_PUBLIC_SOLANA_NETWORK,
    nonce,
    issuedAt,
    expiresAt,
    challengeId,
  };
  const message = buildWalletLinkMessage(challenge);
  if (!message.ok) return refusal(503, 'wallet_service_unavailable');
  return {
    status: 201,
    body: { challengeId, message: message.message, expiresAt },
  };
}

export async function verifyWalletChallenge(
  raw: unknown,
  accessToken: string,
  verifyIdentity: PrivyIdentityVerifier = verifyPrivyWalletIdentity,
): Promise<WalletApiResult> {
  const input = WalletVerificationRequestSchema.safeParse(raw);
  if (!input.success) return refusal(400, 'invalid_request');
  const identity = await privyIdentity(accessToken, input.data.pubkey, verifyIdentity);
  if (isApiResult(identity)) return identity;
  const env = walletEnv();
  const client = walletClient(env);
  const tokenHash = walletSessionTokenHash(input.data.token);
  const { data, error } = await client.rpc('wager_get_wallet_link_challenge', {
    p_token_hash_hex: tokenHash,
    p_challenge_id: input.data.challengeId,
  });
  if (error !== null) return refusal(503, 'wallet_service_unavailable');
  const stored = record(data);
  if (stored?.ok !== true) return refusal(410, 'wallet_link_expired');
  const userId = safePositiveInteger(stored.user_id);
  const issuedAt = canonicalTimestamp(stored.issued_at);
  const expiresAt = canonicalTimestamp(stored.expires_at);
  const storedPubkey = typeof stored.pubkey === 'string' ? stored.pubkey : null;
  const storedHash = typeof stored.challenge_hash_hex === 'string'
    ? stored.challenge_hash_hex
    : null;
  if (
    userId === null || issuedAt === null || expiresAt === null ||
    storedPubkey === null || storedHash === null || storedPubkey !== input.data.pubkey
  ) {
    return refusal(409, 'wallet_link_invalid');
  }
  if (!isPrivySessionOwner(identity, userId)) {
    return refusal(403, 'privy_identity_invalid');
  }
  const nonce = walletChallengeNonce(input.data.token, input.data.challengeId);
  const expectedHash = createHash('sha256').update(nonce).digest('hex');
  if (!equalHex(storedHash, expectedHash)) return refusal(409, 'wallet_link_invalid');
  const challenge: WalletLinkMessageInput = {
    webBaseUrl: new URL(env.WEB_BASE_URL).origin,
    telegramUserId: userId,
    pubkey: storedPubkey,
    cluster: env.NEXT_PUBLIC_SOLANA_NETWORK,
    nonce,
    issuedAt,
    expiresAt,
    challengeId: input.data.challengeId,
  };
  const proof = verifyWalletLinkSignature(
    { pubkey: input.data.pubkey, signatureHex: input.data.signatureHex },
    challenge,
    new Date(),
  );
  if (!proof.ok) {
    return refusal(proof.code === 'challenge_expired' ? 410 : 400, 'signature_invalid');
  }
  const verified = await client.rpc('escrow_verify_privy_wallet_link_session', {
    p_token_hash_hex: tokenHash,
    p_challenge_id: input.data.challengeId,
    p_pubkey: input.data.pubkey,
    p_challenge_hash_hex: expectedHash,
    p_provider_user_id: identity.privyUserId,
    p_provider_wallet_id: identity.walletId,
    p_solana_network: env.NEXT_PUBLIC_SOLANA_NETWORK,
  });
  if (verified.error !== null) return refusal(503, 'wallet_service_unavailable');
  const result = record(verified.data);
  if (result?.ok !== true) {
    const code = typeof result?.code === 'string' ? result.code : 'wallet_link_invalid';
    return refusal(code === 'challenge_expired' ? 410 : 409, code);
  }
  return { status: 200, body: { wallet: { status: 'verified', pubkey: storedPubkey } } };
}

async function privyIdentity(
  accessToken: string,
  pubkey: string,
  verifyIdentity: PrivyIdentityVerifier,
): Promise<PrivyWalletIdentity | WalletApiResult> {
  try {
    return await verifyIdentity(accessToken, pubkey);
  } catch (cause) {
    if (!(cause instanceof PrivyIdentityError)) throw cause;
    switch (cause.code) {
      case 'unauthenticated':
        return refusal(401, 'privy_auth_required');
      case 'identity_mismatch':
      case 'wallet_not_owned':
        return refusal(403, 'privy_identity_invalid');
      case 'provider_unavailable':
        return refusal(503, 'wallet_service_unavailable');
    }
  }
}

function walletEnv() {
  const env = loadWebEnv();
  if (
    !env.WALLET_MINIAPP_ENABLED || env.SUPABASE_URL === undefined ||
    env.SUPABASE_SERVICE_ROLE_KEY === undefined || env.WEB_BASE_URL === undefined
  ) {
    throw new Error('wallet capability unavailable');
  }
  return {
    ...env,
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    WEB_BASE_URL: env.WEB_BASE_URL,
  };
}

function walletClient(env: ReturnType<typeof walletEnv>) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function refusal(status: number, error: string): WalletApiResult {
  return { status, body: { error } };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function isApiResult(value: PrivyWalletIdentity | WalletApiResult): value is WalletApiResult {
  return 'status' in value;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function safePositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function equalHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
