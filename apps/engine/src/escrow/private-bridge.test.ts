import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../ports.js';
import { createSupabaseEscrowPrivateBridge } from './private-bridge.js';
import type { EscrowFinalizedTransactionProjection } from './finalized-indexer.js';

const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const TOKEN = 'a'.repeat(43);
const NOW = Date.parse('2026-07-15T00:00:00.000Z');
const MARKET = {
  id: MARKET_ID,
  currency: 'sol',
  quote_multiplier: 2,
  odds_message_id: 'odds-1',
  odds_ts: NOW - 1_000,
} as MarketRow;

function response(value: unknown, ok = true): Pick<Response, 'ok' | 'status' | 'json'> {
  return { ok, status: ok ? 200 : 500, async json() { return value; } };
}

function transaction(eventKind: 'placed' | 'activated' | 'invalidated'): EscrowFinalizedTransactionProjection {
  return {
    signature: `signature-${eventKind}`,
    slot: eventKind === 'placed' ? 10n : 11n,
    blockTimeIso: '2026-07-15T00:00:01.000Z',
    projections: [{
      kind: 'position', marketId: MARKET_ID, positionPda: 'position', ownerPubkey: 'owner',
      lotNonce: 2n, eventKind, side: 'back', asset: 'sol', amountAtomic: 25n,
      eventEpoch: 3n,
      state: eventKind === 'placed' ? 'pending' : eventKind === 'activated' ? 'active' : 'invalidated',
    }],
  };
}

describe('private escrow Telegram/read-model bridge', () => {
  it('resolves only the exact private Privy identity and stores only a wallet token hash', async () => {
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const bridge = createSupabaseEscrowPrivateBridge({
      supabaseUrl: 'https://db.test', serviceRoleKey: 'service-role', network: 'devnet',
      markets: { async getMarket() { return MARKET; } }, clock: () => NOW, token: () => TOKEN,
      async fetch(input, init) {
        const url = new URL(input);
        calls.push({ url, init });
        if (url.pathname.endsWith('/wager_wallet_links')) {
          return response([{
            user_id: 42, pubkey: 'owner', wallet_provider: 'privy',
            provider_user_id: 'did:privy:42', provider_wallet_id: 'wallet-42',
            solana_network: 'devnet',
          }]);
        }
        return response({ ok: true, session_id: '123e4567-e89b-42d3-a456-426614174000' });
      },
    });

    await expect(bridge.resolve(42)).resolves.toEqual({
      telegramUserId: 42, privyUserId: 'did:privy:42', privyWalletId: 'wallet-42',
      ownerPubkey: 'owner',
    });
    await expect(bridge.create({ telegramUserId: 42, idempotencyKey: 'wallet-42' }))
      .resolves.toEqual({ kind: 'created', token: TOKEN, expiresAt: '2026-07-15T00:05:00.000Z' });

    const body = String(calls[1]?.init?.body);
    expect(body).not.toContain(TOKEN);
    expect(body).toContain(createHash('sha256').update(TOKEN).digest('hex'));
    expect(JSON.parse(body)).toMatchObject({ p_solana_network: 'devnet' });
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer service-role' });
    expect(calls[0]?.url.searchParams.get('solana_network')).toBe('eq.devnet');
  });

  it('projects a signed finalized lot idempotently and transitions only that deterministic row', async () => {
    const writes: Array<{ method: string; url: URL; body: unknown; prefer: string | null }> = [];
    const bridge = createSupabaseEscrowPrivateBridge({
      supabaseUrl: 'https://db.test', serviceRoleKey: 'service-role', network: 'mainnet-beta',
      markets: { async getMarket() { return MARKET; } }, clock: () => NOW,
      async fetch(input, init) {
        const url = new URL(input);
        if (url.pathname.endsWith('/escrow_signing_sessions')) return response([{ user_id: 42 }]);
        const headers = new Headers(init?.headers);
        writes.push({
          method: init?.method ?? 'GET', url,
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
          prefer: headers.get('prefer'),
        });
        return init?.method === 'PATCH' ? response([{ id: 'updated' }]) : response(null);
      },
    });

    await bridge.project(transaction('placed'));
    await bridge.project(transaction('placed'));
    await bridge.project(transaction('activated'));

    expect(writes.map((write) => write.method)).toEqual(['POST', 'POST', 'PATCH']);
    expect(writes[0]?.prefer).toContain('ignore-duplicates');
    expect(writes[0]?.body).toMatchObject({ user_id: 42, market_id: MARKET_ID, stake: 25, state: 'pending' });
    expect(writes[0]?.body).toEqual(writes[1]?.body);
    expect(writes[2]?.url.searchParams.get('id')).toBe(`eq.${(writes[0]?.body as { id: string }).id}`);
    expect(writes[2]?.body).toEqual({ state: 'active' });
  });

  it('does not invent a Telegram identity for a direct on-chain position', async () => {
    let writes = 0;
    const bridge = createSupabaseEscrowPrivateBridge({
      supabaseUrl: 'https://db.test', serviceRoleKey: 'service-role', network: 'devnet',
      markets: { async getMarket() { return MARKET; } }, clock: () => NOW,
      async fetch(input) {
        if (new URL(input).pathname.endsWith('/escrow_signing_sessions')) return response([]);
        writes += 1;
        return response(null);
      },
    });

    await bridge.project(transaction('placed'));
    expect(writes).toBe(0);
  });
});
