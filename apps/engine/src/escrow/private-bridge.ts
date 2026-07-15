import { createHash, randomBytes } from 'node:crypto';
import type { MarketRow } from '../ports.js';
import type { EscrowFinalizedTransactionProjection } from './finalized-indexer.js';
import type {
  EscrowPrivateWalletIdentityProvider,
  EscrowPrivateWalletSessionProvider,
} from './telegram-port.js';

type FetchPort = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

type PrivateWalletIdentity = NonNullable<
  Awaited<ReturnType<EscrowPrivateWalletIdentityProvider['resolve']>>
>;

export interface EscrowPrivateMarketReader {
  getMarket(marketId: string): Promise<MarketRow | null>;
}

export interface EscrowPrivateFinalizedBridge {
  project(transaction: EscrowFinalizedTransactionProjection): Promise<void>;
}

export class EscrowPrivateBridgeError extends Error {
  readonly name = 'EscrowPrivateBridgeError';

  constructor(readonly code: 'dependency_failure' | 'identity_conflict' | 'market_unavailable' | 'invalid_projection') {
    super(`escrow private bridge rejected: ${code}`);
  }
}

function databaseHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    'content-type': 'application/json',
  };
}

function row(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function rows(value: unknown): readonly Readonly<Record<string, unknown>>[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(row);
  return parsed.every((item) => item !== null)
    ? parsed as readonly Readonly<Record<string, unknown>>[]
    : null;
}

function safeUserId(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positionId(marketId: string, ownerPubkey: string, lotNonce: bigint): string {
  const bytes = createHash('sha256')
    .update(`calledit:escrow-position:v1:${marketId}:${ownerPubkey}:${lotNonce}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function placedAtMs(transaction: EscrowFinalizedTransactionProjection): number {
  const blockTime = transaction.blockTimeIso === null ? NaN : Date.parse(transaction.blockTimeIso);
  if (Number.isSafeInteger(blockTime) && blockTime >= 0) return blockTime;
  const slot = Number(transaction.slot);
  if (!Number.isSafeInteger(slot) || slot < 0) {
    throw new EscrowPrivateBridgeError('invalid_projection');
  }
  return slot;
}

export function createSupabaseEscrowPrivateBridge(options: {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly network: 'devnet' | 'mainnet-beta';
  readonly markets: EscrowPrivateMarketReader;
  readonly clock: () => number;
  readonly fetch?: FetchPort;
  readonly token?: () => string;
}): EscrowPrivateWalletIdentityProvider & EscrowPrivateWalletSessionProvider & EscrowPrivateFinalizedBridge {
  const request = options.fetch ?? fetch;
  const headers = databaseHeaders(options.serviceRoleKey);
  const endpoint = (path: string) => new URL(path, options.supabaseUrl);

  async function json(path: URL, init?: RequestInit): Promise<unknown> {
    let response: Pick<Response, 'ok' | 'status' | 'json'>;
    try {
      response = await request(path, { ...init, headers: { ...headers, ...init?.headers } });
    } catch (error) {
      throw new EscrowPrivateBridgeError('dependency_failure');
    }
    if (!response.ok) throw new EscrowPrivateBridgeError('dependency_failure');
    try {
      return await response.json();
    } catch (error) {
      throw new EscrowPrivateBridgeError('dependency_failure');
    }
  }

  async function currentIdentity(telegramUserId: number): Promise<PrivateWalletIdentity | null> {
    if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return null;
    const url = endpoint('/rest/v1/escrow_wallet_links');
    url.searchParams.set(
      'select',
      'user_id,pubkey,wallet_provider,provider_user_id,provider_wallet_id,solana_network',
    );
    url.searchParams.set('user_id', `eq.${telegramUserId}`);
    url.searchParams.set('wallet_provider', 'eq.privy');
    url.searchParams.set('solana_network', `eq.${options.network}`);
    url.searchParams.set('limit', '2');
    const result = rows(await json(url));
    if (result === null || result.length > 1) {
      throw new EscrowPrivateBridgeError('identity_conflict');
    }
    const value = result[0];
    if (value === undefined) return null;
    const userId = safeUserId(value.user_id);
    if (
      userId !== telegramUserId || value.wallet_provider !== 'privy' ||
      value.solana_network !== options.network || typeof value.pubkey !== 'string' ||
      typeof value.provider_user_id !== 'string' || typeof value.provider_wallet_id !== 'string' ||
      value.pubkey.length === 0 || value.provider_user_id.length === 0 || value.provider_wallet_id.length === 0
    ) throw new EscrowPrivateBridgeError('identity_conflict');
    return {
      telegramUserId: userId,
      privyUserId: value.provider_user_id,
      privyWalletId: value.provider_wallet_id,
      ownerPubkey: value.pubkey,
    };
  }

  async function telegramUserForSession(marketId: string, ownerPubkey: string): Promise<number | null> {
    const url = endpoint('/rest/v1/escrow_signing_sessions');
    url.searchParams.set('select', 'user_id');
    url.searchParams.set('market_id', `eq.${marketId}`);
    url.searchParams.set('owner_pubkey', `eq.${ownerPubkey}`);
    url.searchParams.set('limit', '100');
    const result = rows(await json(url));
    if (result === null) throw new EscrowPrivateBridgeError('identity_conflict');
    const users = new Set<number>();
    for (const value of result) {
      const userId = safeUserId(value.user_id);
      if (userId === null) throw new EscrowPrivateBridgeError('identity_conflict');
      users.add(userId);
    }
    if (users.size > 1) throw new EscrowPrivateBridgeError('identity_conflict');
    return users.values().next().value ?? null;
  }

  async function insertPlacedPosition(input: {
    readonly transaction: EscrowFinalizedTransactionProjection;
    readonly projection: Extract<EscrowFinalizedTransactionProjection['projections'][number], { kind: 'position' }>;
    readonly market: MarketRow;
    readonly userId: number;
  }): Promise<void> {
    const amount = Number(input.projection.amountAtomic);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new EscrowPrivateBridgeError('invalid_projection');
    }
    const url = endpoint('/rest/v1/positions');
    url.searchParams.set('on_conflict', 'id');
    const response = await request(url, {
      method: 'POST',
      headers: {
        ...headers,
        prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: positionId(input.projection.marketId, input.projection.ownerPubkey, input.projection.lotNonce),
        market_id: input.projection.marketId,
        user_id: input.userId,
        side: input.projection.side,
        stake: amount,
        locked_multiplier: input.market.quote_multiplier,
        locked_odds_message_id: input.market.odds_message_id,
        locked_odds_ts: input.market.odds_ts,
        state: input.projection.state === 'active' ? 'active' : 'pending',
        placed_at_ms: placedAtMs(input.transaction),
      }),
    }).catch(() => null);
    if (response === null || !response.ok) {
      throw new EscrowPrivateBridgeError('dependency_failure');
    }
  }

  async function transitionPosition(input: {
    readonly projection: Extract<EscrowFinalizedTransactionProjection['projections'][number], { kind: 'position' }>;
  }): Promise<void> {
    const url = endpoint('/rest/v1/positions');
    url.searchParams.set(
      'id',
      `eq.${positionId(input.projection.marketId, input.projection.ownerPubkey, input.projection.lotNonce)}`,
    );
    const value = await json(url, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ state: input.projection.eventKind === 'invalidated' ? 'void' : 'active' }),
    });
    const updated = rows(value);
    if (updated === null || updated.length !== 1) {
      throw new EscrowPrivateBridgeError('invalid_projection');
    }
  }

  return {
    resolve: currentIdentity,

    async create(input) {
      try {
        if (!Number.isSafeInteger(input.telegramUserId) || input.telegramUserId <= 0 || input.idempotencyKey.length === 0) {
          return { kind: 'rejected', code: 'temporarily_unavailable' };
        }
        const token = options.token?.() ?? randomBytes(32).toString('base64url');
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
          return { kind: 'rejected', code: 'temporarily_unavailable' };
        }
        const expiresAt = new Date(options.clock() + 5 * 60_000).toISOString();
        const url = endpoint('/rest/v1/rpc/wager_create_wallet_link_session');
        const result = row(await json(url, {
          method: 'POST',
          body: JSON.stringify({
            p_user_id: input.telegramUserId,
            p_token_hash_hex: createHash('sha256').update(token).digest('hex'),
            p_expires_at: expiresAt,
            p_solana_network: options.network,
          }),
        }));
        if (result?.ok !== true || typeof result.session_id !== 'string') {
          return { kind: 'rejected', code: 'temporarily_unavailable' };
        }
        return { kind: 'created', token, expiresAt };
      } catch (error) {
        if (error instanceof EscrowPrivateBridgeError) {
          return { kind: 'rejected', code: 'temporarily_unavailable' };
        }
        throw error;
      }
    },

    async project(transaction) {
      for (const projection of transaction.projections) {
        if (projection.kind !== 'position') continue;
        const userId = await telegramUserForSession(projection.marketId, projection.ownerPubkey);
        if (userId === null) continue;
        if (projection.eventKind === 'placed') {
          const market = await options.markets.getMarket(projection.marketId);
          if (market === null || market.currency !== projection.asset) {
            throw new EscrowPrivateBridgeError('market_unavailable');
          }
          await insertPlacedPosition({ transaction, projection, market, userId });
          continue;
        }
        if (projection.eventKind === 'activated' || projection.eventKind === 'invalidated') {
          await transitionPosition({ projection });
        }
      }
    },
  };
}
