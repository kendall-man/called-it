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
        if (url.pathname.endsWith('/escrow_wallet_links')) {
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

  it('emits one resolved position event per projected write and survives a throwing hook', async () => {
    const events: Array<{ eventKind: string; telegramUserId: number; marketId: string }> = [];
    let hookCalls = 0;
    const bridge = createSupabaseEscrowPrivateBridge({
      supabaseUrl: 'https://db.test', serviceRoleKey: 'service-role', network: 'devnet',
      markets: { async getMarket() { return MARKET; } }, clock: () => NOW,
      positionEvents: {
        async onFinalizedPositionEvent(event) {
          hookCalls += 1;
          if (hookCalls === 2) throw new Error('notification transport down');
          events.push({
            eventKind: event.eventKind,
            telegramUserId: event.telegramUserId,
            marketId: event.marketId,
          });
        },
      },
      async fetch(input, init) {
        const url = new URL(input);
        if (url.pathname.endsWith('/escrow_signing_sessions')) return response([{ user_id: 42 }]);
        return init?.method === 'PATCH' ? response([{ id: 'updated' }]) : response(null);
      },
    });

    await bridge.project(transaction('placed'));
    // The throwing hook must not fail the projection behind the cursor.
    await expect(bridge.project(transaction('activated'))).resolves.toBeUndefined();
    await bridge.project(transaction('invalidated'));

    expect(hookCalls).toBe(3);
    expect(events).toEqual([
      { eventKind: 'placed', telegramUserId: 42, marketId: MARKET_ID },
      { eventKind: 'invalidated', telegramUserId: 42, marketId: MARKET_ID },
    ]);
  });

  it('joins a dead-lettered placement job back to its Telegram signer', async () => {
    const jobId = '9f14d0ab-9605-4a62-a9e4-5ed26688389b';
    const bridge = createSupabaseEscrowPrivateBridge({
      supabaseUrl: 'https://db.test', serviceRoleKey: 'service-role', network: 'devnet',
      markets: { async getMarket() { return MARKET; } }, clock: () => NOW,
      async fetch(input) {
        const url = new URL(input);
        if (url.pathname.endsWith('/escrow_relayer_jobs')) {
          expect(url.searchParams.get('id')).toBe(`eq.${jobId}`);
          return response([{ kind: 'position_placement', market_id: MARKET_ID, owner_pubkey: 'owner' }]);
        }
        if (url.pathname.endsWith('/escrow_signing_sessions')) return response([{ user_id: 42 }]);
        return response(null);
      },
    });

    await expect(bridge.resolveRelayerJobSigner(jobId)).resolves.toEqual({
      kind: 'position_placement',
      telegramUserId: 42,
    });
    await expect(bridge.resolveRelayerJobSigner('not-a-job-id')).resolves.toBeNull();
  });

  it('never attributes a non-placement job or a failed lookup to a user', async () => {
    const jobId = '9f14d0ab-9605-4a62-a9e4-5ed26688389b';
    const freezeBridge = createSupabaseEscrowPrivateBridge({
      supabaseUrl: 'https://db.test', serviceRoleKey: 'service-role', network: 'devnet',
      markets: { async getMarket() { return MARKET; } }, clock: () => NOW,
      async fetch(input) {
        const url = new URL(input);
        if (url.pathname.endsWith('/escrow_relayer_jobs')) {
          return response([{ kind: 'freeze', market_id: MARKET_ID, owner_pubkey: null }]);
        }
        throw new Error('unexpected lookup');
      },
    });
    await expect(freezeBridge.resolveRelayerJobSigner(jobId)).resolves.toEqual({
      kind: 'freeze',
      telegramUserId: null,
    });

    const failingBridge = createSupabaseEscrowPrivateBridge({
      supabaseUrl: 'https://db.test', serviceRoleKey: 'service-role', network: 'devnet',
      markets: { async getMarket() { return MARKET; } }, clock: () => NOW,
      async fetch() { return response(null, false); },
    });
    await expect(failingBridge.resolveRelayerJobSigner(jobId)).resolves.toBeNull();
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
