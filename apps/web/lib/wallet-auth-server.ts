import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  type JsonWebKey,
} from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { loadWebEnv } from './env';
import { walletAuthSubject, type WalletAuthNetwork } from './wallet-auth-subject';
import { walletSessionTokenHash } from './wallet-link-server';

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIN_SESSION_LIFETIME_MS = 10_000;

const WalletAuthRequestSchema = z.object({
  token: z.string().regex(SESSION_TOKEN_PATTERN),
}).strict();

export interface WalletAuthApiResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

type WalletAuthConfig = {
  readonly appId: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly network: WalletAuthNetwork;
  readonly privateKeyBase64: string;
  readonly supabaseServiceRoleKey: string;
  readonly supabaseUrl: string;
};

type WalletLinkSession = {
  readonly expiresAt: number;
  readonly userId: number;
};

export async function createWalletAuthSession(raw: unknown): Promise<WalletAuthApiResult> {
  const input = WalletAuthRequestSchema.safeParse(raw);
  if (!input.success) return refusal(400, 'invalid_request');

  const config = walletAuthConfig();
  const session = await lookupWalletLinkSession(
    config,
    walletSessionTokenHash(input.data.token),
  );
  if (session === null || session.expiresAt - Date.now() < MIN_SESSION_LIFETIME_MS) {
    return refusal(410, 'wallet_link_expired');
  }

  const jwt = await signWalletAuthJwt(config, session);
  return {
    status: 201,
    body: { jwt, expiresAt: new Date(session.expiresAt).toISOString() },
  };
}

export function walletAuthJwks(): { readonly keys: readonly JsonWebKey[] } {
  const config = walletAuthConfig();
  const privateKey = readWalletAuthPrivateKey(config.privateKeyBase64);
  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' });
  if (publicKey.kty !== 'EC' || publicKey.crv !== 'P-256') {
    throw new Error('wallet auth key must be an ES256 P-256 key');
  }
  return {
    keys: [{
      ...publicKey,
      alg: 'ES256',
      kid: config.keyId,
      use: 'sig',
    }],
  };
}

export async function signWalletAuthJwt(
  config: Pick<WalletAuthConfig, 'appId' | 'issuer' | 'keyId' | 'network' | 'privateKeyBase64'>,
  session: WalletLinkSession,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const expiresAt = Math.floor(session.expiresAt / 1_000);
  if (expiresAt <= now) throw new Error('wallet session expired');
  const key = await importPKCS8(walletAuthPrivateKeyPem(config.privateKeyBase64), 'ES256');
  return new SignJWT()
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId, typ: 'JWT' })
    .setSubject(walletAuthSubject(config.network, session.userId))
    .setIssuer(config.issuer)
    .setAudience(config.appId)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(key);
}

async function lookupWalletLinkSession(
  config: WalletAuthConfig,
  tokenHashHex: string,
): Promise<WalletLinkSession | null> {
  const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.rpc('wager_get_wallet_link_session', {
    p_token_hash_hex: tokenHashHex,
  });
  if (error !== null) throw new Error('wallet session lookup failed', { cause: error });
  const result = record(data);
  if (result?.ok !== true) return null;
  const userId = safePositiveInteger(result.user_id);
  const expiresAt = typeof result.expires_at === 'string'
    ? Date.parse(result.expires_at)
    : Number.NaN;
  if (userId === null || !Number.isFinite(expiresAt)) return null;
  return { userId, expiresAt };
}

function walletAuthConfig(): WalletAuthConfig {
  const env = loadWebEnv();
  if (
    !env.WALLET_MINIAPP_ENABLED || env.WALLET_PROVIDER !== 'privy' ||
    env.PRIVY_APP_ID === undefined || env.WEB_BASE_URL === undefined ||
    env.SUPABASE_URL === undefined || env.SUPABASE_SERVICE_ROLE_KEY === undefined ||
    env.WALLET_AUTH_PRIVATE_KEY === undefined || env.WALLET_AUTH_KEY_ID === undefined
  ) {
    throw new Error('wallet auth unavailable');
  }
  return {
    appId: env.PRIVY_APP_ID,
    issuer: new URL(env.WEB_BASE_URL).origin,
    keyId: env.WALLET_AUTH_KEY_ID,
    network: env.NEXT_PUBLIC_SOLANA_NETWORK,
    privateKeyBase64: env.WALLET_AUTH_PRIVATE_KEY,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseUrl: env.SUPABASE_URL,
  };
}

function readWalletAuthPrivateKey(base64: string) {
  const key = Buffer.from(base64, 'base64');
  if (key.length === 0 || key.toString('base64') !== base64) {
    throw new Error('wallet auth key invalid');
  }
  return createPrivateKey({ key, format: 'der', type: 'pkcs8' });
}

function walletAuthPrivateKeyPem(base64: string): string {
  readWalletAuthPrivateKey(base64);
  const lines = base64.match(/.{1,64}/g);
  if (lines === null) throw new Error('wallet auth key invalid');
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

function refusal(status: number, error: string): WalletAuthApiResult {
  return { status, body: { error } };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function safePositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
