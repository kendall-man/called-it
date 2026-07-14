import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { loadWebEnv } from './env';
import {
  PrivyIdentityError,
  verifyPrivyWalletIdentity,
  type PrivyIdentityVerifier,
} from './privy-server';

const PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const OPEN_MARKET_STATUSES = ['pending_lineup', 'open', 'frozen', 'settling'] as const;

const WalletAccountRequestSchema = z.object({
  pubkey: z.string().regex(PUBKEY_PATTERN),
}).strict();

export interface WalletAccountApiResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface WalletAccountStore {
  summary(userId: number, pubkey: string): Promise<{
    readonly availableLamports: bigint;
    readonly lockedLamports: bigint;
  } | null>;
}

export async function getWalletAccountSummary(
  raw: unknown,
  accessToken: string,
  verifyIdentity: PrivyIdentityVerifier = verifyPrivyWalletIdentity,
  store?: WalletAccountStore,
): Promise<WalletAccountApiResult> {
  const input = WalletAccountRequestSchema.safeParse(raw);
  if (!input.success) return refusal(400, 'invalid_request');

  let identity;
  try {
    identity = await verifyIdentity(accessToken, input.data.pubkey);
  } catch (cause) {
    if (!(cause instanceof PrivyIdentityError)) throw cause;
    if (cause.code === 'unauthenticated') return refusal(401, 'privy_auth_required');
    if (cause.code === 'provider_unavailable') {
      return refusal(503, 'wallet_service_unavailable');
    }
    return refusal(403, 'privy_identity_invalid');
  }

  const userId = Number(identity.telegramUserId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return refusal(403, 'privy_identity_invalid');
  }
  const summary = await (store ?? createWalletAccountStore()).summary(userId, identity.pubkey);
  if (summary === null) return refusal(403, 'privy_identity_invalid');
  return {
    status: 200,
    body: {
      availableLamports: summary.availableLamports.toString(),
      lockedLamports: summary.lockedLamports.toString(),
    },
  };
}

function createWalletAccountStore(): WalletAccountStore {
  const env = loadWebEnv();
  if (env.SUPABASE_URL === undefined || env.SUPABASE_SERVICE_ROLE_KEY === undefined) {
    throw new Error('wallet account capability unavailable');
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async summary(userId, pubkey) {
      const link = await client
        .from('wager_wallet_links')
        .select('user_id')
        .eq('user_id', userId)
        .eq('pubkey', pubkey)
        .maybeSingle();
      if (link.error !== null) throw new Error('wallet account lookup failed');
      if (link.data === null) return null;

      const [ledger, markets] = await Promise.all([
        client.from('wager_ledger_entries').select('lamports').eq('user_id', userId),
        client
          .from('markets')
          .select('id')
          .eq('currency', 'sol')
          .in('status', [...OPEN_MARKET_STATUSES]),
      ]);
      if (ledger.error !== null || markets.error !== null) {
        throw new Error('wallet account lookup failed');
      }
      const availableLamports = (ledger.data ?? []).reduce(
        (sum, row) => sum + parseLamports(row.lamports),
        0n,
      );
      const marketIds = (markets.data ?? [])
        .map((row) => row.id)
        .filter((id): id is string => typeof id === 'string');
      if (marketIds.length === 0) return { availableLamports, lockedLamports: 0n };

      const positions = await client
        .from('positions')
        .select('stake,state')
        .eq('user_id', userId)
        .in('market_id', marketIds)
        .neq('state', 'void');
      if (positions.error !== null) throw new Error('wallet account lookup failed');
      const lockedLamports = (positions.data ?? []).reduce(
        (sum, row) => sum + parseLamports(row.stake),
        0n,
      );
      return { availableLamports, lockedLamports };
    },
  };
}

function parseLamports(value: unknown): bigint {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^-?\d+$/.test(text)) throw new Error('wallet account amount invalid');
  return BigInt(text);
}

function refusal(status: number, error: string): WalletAccountApiResult {
  return { status, body: { error } };
}
