/**
 * Behavior tests for the engine HTTP API — the concierge integration surface.
 * Focus: auth, the stake money path over HTTP (guards + idempotent replay),
 * and the read-only quote flow with a scripted parser.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { TUNABLES } from '@calledit/market-engine';
import { startEngineApi } from './server.js';
import type { Deps, EngineDb, FixtureRow, LedgerEntry, MarketRow, PositionRow } from '../ports.js';
import type { Env } from '../env.js';
import type { Poster } from '../bot/poster.js';

const NOW = Date.parse('2026-07-08T12:00:00.000Z');
const CHAT_ID = -100555;
const USER_ID = 9001;
const MARKET_ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'test-engine-api-token-0123456789';

const FIXTURE: FixtureRow = {
  fixture_id: 42,
  p1_name: 'Portugal',
  p2_name: 'Spain',
  kickoff_at: new Date(NOW + 3_600_000).toISOString(),
  phase: 'NS',
  minute: null,
  last_seq: 0,
  score: {},
} as unknown as FixtureRow;

const MARKET: MarketRow = {
  id: MARKET_ID,
  claim_id: 'claim-1',
  group_id: CHAT_ID,
  fixture_id: FIXTURE.fixture_id,
  spec: {
    claimType: 'match_winner',
    fixtureId: FIXTURE.fixture_id,
    entityRef: { kind: 'team', name: 'Spain', participant: 2 },
    comparator: 'gte',
    threshold: 1,
    period: 'FT_90',
    trustTier: 'chain_proven',
  } as unknown as MarketRow['spec'],
  status: 'open',
  is_replay: false,
  price_provenance: 'market',
  quote_probability: 0.5,
  quote_multiplier: 2,
  odds_message_id: 'om-1',
  odds_ts: NOW - 1000,
  card_tg_message_id: null,
  created_at: new Date(NOW).toISOString(),
};

interface ApiHarness {
  base: string;
  positions: PositionRow[];
  ledger: LedgerEntry[];
}

let activeServer: Server | null = null;

afterEach(() => {
  activeServer?.close();
  activeServer = null;
});

async function startHarness(opts: { balance?: number } = {}): Promise<ApiHarness> {
  const positions: PositionRow[] = [];
  const ledger: LedgerEntry[] = [];
  let seq = 0;
  const startingBalance = opts.balance ?? TUNABLES.STARTING_BALANCE;

  const db = {
    getGroup: async (id: number) =>
      id === CHAT_ID ? { id, title: 'Test Group', chattiness: 'normal', web_enabled: true, slug: 'slug' } : null,
    getMarket: async (id: string) => (id === MARKET_ID ? { ...MARKET } : null),
    getFixture: async () => FIXTURE,
    openMarketsForGroup: async () => [{ ...MARKET }],
    leaderboard: async () => [
      { user_id: USER_ID, display_name: 'Dee', points_cached: 120, streak: 2 },
    ],
    fixturesBetween: async () => [FIXTURE],
    playersForFixture: async () => [],
    getUser: async (id: number) =>
      id === USER_ID ? { id, display_name: 'Dee Real Name', username: 'dee' } : null,
    upsertUser: async () => undefined,
    ensureMembership: async () => ({ created: false }),
    positionsForMarket: async (marketId: string) =>
      positions.filter((p) => p.market_id === marketId).map((p) => ({ ...p })),
    insertPosition: async (input: Omit<PositionRow, 'id'>) => {
      seq += 1;
      const row: PositionRow = { ...input, id: `pos-${seq}` };
      positions.push(row);
      return row;
    },
    postLedger: async (entry: LedgerEntry) => {
      if (ledger.some((e) => e.idempotency_key === entry.idempotency_key)) return { inserted: false };
      ledger.push(entry);
      return { inserted: true };
    },
    hasLedgerEntry: async (key: string) => ledger.some((e) => e.idempotency_key === key),
    balance: async (_g: number, userId: number) =>
      startingBalance + ledger.filter((e) => e.user_id === userId).reduce((s, e) => s + e.amount, 0),
  } as unknown as EngineDb;

  const deps = {
    db,
    agent: {
      parse: async () => ({
        claimType: 'match_winner',
        fixtureId: FIXTURE.fixture_id,
        entityName: 'Spain',
        entityKind: 'team',
        comparator: null,
        threshold: null,
        period: 'FT_90',
        unresolved: null,
      }),
    },
    engine: {
      compileClaim: () => ({ kind: 'ok' as const, spec: MARKET.spec }),
      priceSpec: () => ({
        probability: 0.5,
        multiplier: 2,
        provenance: 'market' as const,
        oddsMessageId: 'om-1',
        oddsTsMs: NOW - 1000,
      }),
    },
    tx: {
      fetchOdds: async () =>
        ({ kind: 'ok', odds: { p1x2: { home: 0.3, draw: 0.2, away: 0.5 }, oddsMessageId: 'om-1', oddsTsMs: NOW - 1000 } }) as const,
    },
    proofSubmitter: null,
    env: { WEB_BASE_URL: 'https://web.test' },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => NOW,
  } as unknown as Deps;

  const poster = { post: () => undefined, editCard: () => undefined, stripKeyboard: () => undefined } as unknown as Poster;
  const env = { ENGINE_API_TOKEN: TOKEN, PORT: 0, WEB_BASE_URL: 'https://web.test' } as unknown as Env;

  const server = startEngineApi({ deps, poster, env, log: deps.log });
  if (!server) throw new Error('api did not start');
  activeServer = server;
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}`, positions, ledger };
}

const authed = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

describe('engine API', () => {
  it('starts only when a token is configured', () => {
    const server = startEngineApi({
      deps: { log: { info: () => undefined } } as unknown as Deps,
      poster: {} as Poster,
      env: { ENGINE_API_TOKEN: undefined, PORT: 0 } as unknown as Env,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    });
    expect(server).toBeNull();
  });

  it('rejects a missing or wrong bearer token', async () => {
    const hz = await startHarness();
    const bare = await fetch(`${hz.base}/api/groups/${CHAT_ID}/snapshot`);
    expect(bare.status).toBe(401);
    const wrong = await fetch(`${hz.base}/api/groups/${CHAT_ID}/snapshot`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    // health stays public for platform checks
    const health = await fetch(`${hz.base}/api/health`);
    expect(health.status).toBe(200);
  });

  it('serves the group snapshot with markets and leaderboard', async () => {
    const hz = await startHarness();
    const res = await fetch(`${hz.base}/api/groups/${CHAT_ID}/snapshot`, { headers: authed });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markets: unknown[]; leaderboard: Array<{ rep: number }> };
    expect(body.markets).toHaveLength(1);
    expect(body.leaderboard[0]?.rep).toBe(120);
  });

  it('places a stake over HTTP and debits the ledger', async () => {
    const hz = await startHarness();
    const res = await fetch(`${hz.base}/api/stake`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({
        chatId: CHAT_ID,
        marketId: MARKET_ID,
        userId: USER_ID,
        displayName: 'Dee',
        side: 'back',
        amount: 30,
        idempotencyKey: 'call-abc-123',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('ok');
    expect(hz.positions).toHaveLength(1);
    expect(hz.positions[0]).toMatchObject({ stake: 30, side: 'back', user_id: USER_ID });
    expect(hz.ledger.find((e) => e.kind === 'stake')?.amount).toBe(-30);
    expect(hz.ledger.find((e) => e.kind === 'stake')?.idempotency_key).toBe('stake-api:call-abc-123');
  });

  it('replaying the same idempotency key changes nothing (eve step re-run)', async () => {
    const hz = await startHarness();
    const stakeBody = JSON.stringify({
      chatId: CHAT_ID,
      marketId: MARKET_ID,
      userId: USER_ID,
      displayName: 'Dee',
      side: 'back',
      amount: 30,
      idempotencyKey: 'call-dup-1',
    });
    const first = await fetch(`${hz.base}/api/stake`, { method: 'POST', headers: authed, body: stakeBody });
    expect(first.status).toBe(200);
    const second = await fetch(`${hz.base}/api/stake`, { method: 'POST', headers: authed, body: stakeBody });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { kind: string }).kind).toBe('duplicate');
    expect(hz.positions).toHaveLength(1); // no double-stake
  });

  it('rejects negative and fractional amounts', async () => {
    const hz = await startHarness();
    for (const amount of [-50, 2.5, 0]) {
      const res = await fetch(`${hz.base}/api/stake`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({
          chatId: CHAT_ID,
          marketId: MARKET_ID,
          userId: USER_ID,
          displayName: 'Dee',
          side: 'back',
          amount,
          idempotencyKey: `call-neg-${amount}`,
        }),
      });
      expect(res.status).toBe(404); // 'unavailable' — same class as unknown market
    }
    expect(hz.positions).toHaveLength(0);
    expect(hz.ledger).toHaveLength(0); // and definitely no Rep credit
  });

  it('surfaces guard rejections as 422 with the copy key', async () => {
    const hz = await startHarness({ balance: 10 });
    const res = await fetch(`${hz.base}/api/stake`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({
        chatId: CHAT_ID,
        marketId: MARKET_ID,
        userId: USER_ID,
        displayName: 'Dee',
        side: 'back',
        amount: 30,
        idempotencyKey: 'call-poor-1',
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { kind: string; copyKey: string };
    expect(body.copyKey).toBe('insufficient_rep');
  });

  it('quotes a claim read-only (no rows written)', async () => {
    const hz = await startHarness();
    const res = await fetch(`${hz.base}/api/quote`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ chatId: CHAT_ID, text: 'Spain win this easy' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      options: Array<{ quote: { kind: string; backMultiplier?: number } }>;
    };
    expect(body.kind).toBe('ok');
    expect(body.options[0]?.quote.kind).toBe('ok');
    expect(body.options[0]?.quote.backMultiplier).toBe(2);
    expect(hz.positions).toHaveLength(0);
    expect(hz.ledger).toHaveLength(0);
  });
});
