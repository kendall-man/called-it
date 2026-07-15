import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadWebEnv } from './env';
import {
  parsePositionSigningSession,
  type EscrowAccountPosition,
  type PositionIndexedStatus,
  type PositionSigningSession,
} from './position-contract';
import { describeTerms, parseMarketSpec } from './spec-terms';

export type PositionSessionRejection =
  | 'session_not_found'
  | 'session_expired'
  | 'session_consumed'
  | 'invalid_input';

export type PositionSessionLookup =
  | { readonly kind: 'found'; readonly session: PositionSigningSession }
  | { readonly kind: 'rejected'; readonly code: PositionSessionRejection };

export interface PositionStore {
  readSession(tokenHashHex: string, now: Date): Promise<PositionSessionLookup>;
  displayTerms(marketId: string): Promise<string | null>;
  indexedStatus(session: PositionSigningSession, now: Date): Promise<PositionIndexedStatus>;
  accountPositions(ownerPubkey: string): Promise<readonly EscrowAccountPosition[]>;
}

const RpcRefusalSchema = z.object({
  ok: z.literal(false),
  code: z.enum(['session_not_found', 'session_expired', 'session_consumed', 'invalid_input']),
}).passthrough();

const EventRowSchema = z.object({
  event_kind: z.enum(['placed', 'activated', 'invalidated', 'refundable', 'claimed']),
  state: z.enum(['pending', 'active', 'invalidated', 'refundable', 'claimed']),
  commitment: z.enum(['confirmed', 'finalized']),
}).passthrough();

const AccountRowSchema = z.object({
  market_id: z.string().uuid(),
  side: z.enum(['back', 'doubt']),
  asset: z.enum(['sol', 'usdc']),
  deposited_atomic: z.union([z.string(), z.number()]).transform(String),
  pending_atomic: z.union([z.string(), z.number()]).transform(String),
  active_atomic: z.union([z.string(), z.number()]).transform(String),
  refundable_atomic: z.union([z.string(), z.number()]).transform(String),
  claimed_atomic: z.union([z.string(), z.number()]).transform(String),
}).passthrough();

const LinkRowSchema = z.object({
  market_id: z.string().uuid(),
  chain_state: z.string().min(1).max(32),
}).passthrough();

const ReplayRowSchema = z.object({
  id: z.string().uuid(),
  is_replay: z.boolean(),
}).passthrough();

const ClaimedRowSchema = z.object({ market_id: z.string().uuid() }).passthrough();

export function hashPositionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function signingSessionRpcArguments(tokenHashHex: string, now: Date) {
  return {
    p_token_hash_hex: tokenHashHex,
    p_now: now.toISOString(),
  } as const;
}

export function createPositionStore(): PositionStore {
  const env = loadWebEnv();
  if (env.SUPABASE_URL === undefined || env.SUPABASE_SERVICE_ROLE_KEY === undefined) {
    throw new Error('escrow position store unavailable');
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async readSession(tokenHashHex, now) {
      const response = await client.rpc('escrow_get_signing_session', {
        ...signingSessionRpcArguments(tokenHashHex, now),
      });
      if (response.error !== null) throw new Error('escrow signing session lookup failed');
      const refusal = RpcRefusalSchema.safeParse(response.data);
      if (refusal.success) return { kind: 'rejected', code: refusal.data.code };
      const session = parsePositionSigningSession(response.data);
      if (session === null) throw new Error('escrow signing session response invalid');
      return { kind: 'found', session };
    },

    async displayTerms(marketId) {
      const result = await client.from('markets').select('spec').eq('id', marketId).maybeSingle();
      if (result.error !== null) throw new Error('escrow market terms lookup failed');
      const spec = parseMarketSpec(result.data?.spec);
      return spec === null ? null : describeTerms(spec);
    },

    async indexedStatus(session, now) {
      if (session.state === 'pending') {
        return {
          stage: 'awaiting_signature',
          signature: null,
          positionState: null,
          commitment: null,
        };
      }
      if (session.transactionSignature === null) {
        throw new Error('consumed escrow session is missing its signature');
      }
      const result = await client
        .from('escrow_position_events')
        .select('event_kind,state,commitment')
        .eq('signature', session.transactionSignature)
        .eq('market_id', session.marketId)
        .eq('owner_pubkey', session.ownerPubkey)
        .eq('lot_nonce', session.lotNonce.toString())
        .eq('canonical', true)
        .order('instruction_index', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (result.error !== null) throw new Error('escrow position status lookup failed');
      const event = EventRowSchema.safeParse(result.data);
      if (event.success) {
        return {
          stage: event.data.commitment === 'finalized' ? 'finalized' : 'confirming',
          signature: session.transactionSignature,
          positionState: event.data.state,
          commitment: event.data.commitment,
        };
      }
      const expiry = Date.parse(session.expiresAt);
      return {
        stage: Number.isFinite(expiry) && now.getTime() > expiry + 120_000
          ? 'unknown_confirmation'
          : 'confirming',
        signature: session.transactionSignature,
        positionState: null,
        commitment: null,
      };
    },

    async accountPositions(ownerPubkey) {
      const positions = await client
        .from('escrow_position_accounts')
        .select('market_id,side,asset,deposited_atomic,pending_atomic,active_atomic,refundable_atomic,claimed_atomic')
        .eq('owner_pubkey', ownerPubkey)
        .eq('canonical', true)
        .order('updated_at', { ascending: false })
        .limit(20);
      if (positions.error !== null) throw new Error('escrow account position lookup failed');
      const rows = z.array(AccountRowSchema).safeParse(positions.data ?? []);
      if (!rows.success) throw new Error('escrow account position response invalid');
      if (rows.data.length === 0) return [];

      const marketIds = rows.data.map((row) => row.market_id);
      const links = await client
        .from('escrow_market_links')
        .select('market_id,chain_state')
        .in('market_id', marketIds)
        .eq('canonical', true);
      if (links.error !== null) throw new Error('escrow account market lookup failed');
      const parsedLinks = z.array(LinkRowSchema).safeParse(links.data ?? []);
      if (!parsedLinks.success) throw new Error('escrow account market response invalid');
      const stateByMarket = new Map(parsedLinks.data.map((row) => [row.market_id, row.chain_state]));

      const [marketRows, claimRows] = await Promise.all([
        client.from('markets').select('id,is_replay').in('id', marketIds),
        client
          .from('escrow_claim_events')
          .select('market_id')
          .eq('owner_pubkey', ownerPubkey)
          .eq('canonical', true)
          .eq('commitment', 'finalized')
          .in('market_id', marketIds),
      ]);
      if (marketRows.error !== null || claimRows.error !== null) {
        throw new Error('escrow account claim metadata lookup failed');
      }
      const parsedMarkets = z.array(ReplayRowSchema).safeParse(marketRows.data ?? []);
      const parsedClaims = z.array(ClaimedRowSchema).safeParse(claimRows.data ?? []);
      if (!parsedMarkets.success || !parsedClaims.success) {
        throw new Error('escrow account claim metadata response invalid');
      }
      const replayByMarket = new Map(parsedMarkets.data.map((row) => [row.id, row.is_replay]));
      const claimedMarkets = new Set(parsedClaims.data.map((row) => row.market_id));

      return rows.data.map((row) => {
        const pending = parseAtomic(row.pending_atomic);
        const active = parseAtomic(row.active_atomic);
        const refundable = parseAtomic(row.refundable_atomic);
        const claimed = parseAtomic(row.claimed_atomic);
        const deposited = parseAtomic(row.deposited_atomic);
        const chainState = stateByMarket.get(row.market_id) ?? 'unknown';
        const claimState = claimedMarkets.has(row.market_id)
          ? 'claimed'
          : chainState === 'settled' || chainState === 'voided'
            ? 'ready'
            : pending > 0n
            ? 'pending'
            : active > 0n
              ? 'open'
              : refundable > 0n
                ? 'ready'
                : claimed >= deposited && deposited > 0n
                  ? 'claimed'
                  : 'open';
        return {
          marketId: row.market_id,
          side: row.side,
          asset: row.asset,
          depositedAtomic: deposited.toString(),
          pendingAtomic: pending.toString(),
          activeAtomic: active.toString(),
          refundableAtomic: refundable.toString(),
          claimedAtomic: claimed.toString(),
          chainState,
          replay: replayByMarket.get(row.market_id) ?? false,
          claimState,
        };
      });
    },
  };
}

function parseAtomic(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error('escrow account amount invalid');
  return BigInt(value);
}
