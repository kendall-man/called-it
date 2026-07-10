/**
 * Behavior tests for the engine HTTP API — the concierge integration surface.
 * Focus: auth, the SOL stake path over HTTP (routed through the wager module,
 * idempotent replay), the wallet/snapshot reads, and the read-only quote flow.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { startEngineApi } from './server.js';
import type { Deps, EngineDb, FixtureRow, MarketRow } from '../ports.js';
import type { Env } from '../env.js';
import type { Poster } from '../bot/poster.js';
import { createWagerModule } from '../wager/module.js';
import { makeFakeDeps, type FakeWagerDb } from '../wager/fakes.js';
import {
  DrainState,
  ENGINE_READINESS_REASONS,
  createReadinessEvaluator,
  type ReadinessEvaluator,
} from './readiness.js';

const NOW = Date.parse('2026-07-08T12:00:00.000Z');
const CHAT_ID = -100555;
const USER_ID = 9001;
const MARKET_ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'test-engine-api-token-0123456789';
const PUBKEY = 'Wa11etPubkey1111111111111111111111111111';

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
  currency: 'sol',
  created_at: new Date(NOW).toISOString(),
};

interface ApiHarness {
  base: string;
  wagerDb: FakeWagerDb;
}

let activeServer: Server | null = null;

afterEach(() => {
  activeServer?.close();
  activeServer = null;
});

async function startHarness(
  opts: {
    balanceLamports?: bigint;
    link?: boolean;
    market?: MarketRow;
    readiness?: ReadinessEvaluator;
    drainState?: DrainState;
  } = {},
): Promise<ApiHarness> {
  const wagerBundle = makeFakeDeps({ now: () => NOW });
  const wager = createWagerModule(wagerBundle.deps);
  if (opts.link ?? true) wagerBundle.db.seedLink(USER_ID, PUBKEY);
  wagerBundle.db.seedBalance(USER_ID, opts.balanceLamports ?? 1_000_000_000n); // 1 SOL
  wagerBundle.db.seedMarketProbability(MARKET_ID, 0.5);

  const theMarket = opts.market ?? MARKET;
  const db = {
    getGroup: async (id: number) =>
      id === CHAT_ID ? { id, title: 'Test Group', chattiness: 'nudge', web_enabled: true, slug: 'slug' } : null,
    getMarket: async (id: string) => (id === theMarket.id ? { ...theMarket } : null),
    getFixture: async () => FIXTURE,
    openMarketsForGroup: async () => [{ ...theMarket }],
    fixturesBetween: async () => [FIXTURE],
    playersForFixture: async () => [],
    getUser: async (id: number) =>
      id === USER_ID ? { id, display_name: 'Dee Real Name', username: 'dee' } : null,
    upsertUser: async () => undefined,
    ensureMembership: async () => ({ created: false }),
    positionsForMarket: async () => [],
  } as unknown as EngineDb;

  const deps = {
    db,
    wager,
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

  const drainState = opts.drainState ?? new DrainState();
  const readiness =
    opts.readiness ??
    createReadinessEvaluator({
      checks: [],
      checkTimeoutMs: 100,
      deadline: { wait: async () => new Promise<void>(() => undefined) },
      drainState,
    });
  const apiOptions = { deps, poster, env, log: deps.log, readiness, drainState };
  const server = startEngineApi(apiOptions);
  if (!server) throw new Error('api did not start');
  activeServer = server;
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}`, wagerDb: wagerBundle.db };
}

const authed = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function stakeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    chatId: CHAT_ID,
    marketId: MARKET_ID,
    userId: USER_ID,
    displayName: 'Dee',
    side: 'back',
    amount: 0.05,
    idempotencyKey: 'call-abc-123',
    ...overrides,
  });
}

describe('engine API', () => {
  it('starts health routes even when application API auth is unconfigured', () => {
    const server = startEngineApi({
      deps: { log: { info: () => undefined } } as unknown as Deps,
      poster: {} as Poster,
      env: { ENGINE_API_TOKEN: undefined, PORT: 0 } as unknown as Env,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      readiness: { evaluate: async () => ({ status: 'ready', reasons: [] }) },
      drainState: new DrainState(),
    });
    expect(server).not.toBeNull();
    if (server !== null) {
      activeServer = server;
    }
  });

  it('rejects a missing or wrong bearer token', async () => {
    const hz = await startHarness();
    const bare = await fetch(`${hz.base}/api/groups/${CHAT_ID}/snapshot`);
    expect(bare.status).toBe(401);
    const wrong = await fetch(`${hz.base}/api/groups/${CHAT_ID}/snapshot`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    const health = await fetch(`${hz.base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });

  it('reports process liveness without authentication or dependency checks', async () => {
    const hz = await startHarness();

    const live = await fetch(`${hz.base}/api/live`);

    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'live' });
  });

  it('reports a healthy dependency set as ready without authentication', async () => {
    const hz = await startHarness();

    const ready = await fetch(`${hz.base}/api/ready`);

    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready', reasons: [] });
  });

  it('reports a failed database readiness check with a stable reason code', async () => {
    const hz = await startHarness({
      readiness: {
        evaluate: async () => ({
          status: 'not_ready',
          reasons: [ENGINE_READINESS_REASONS.databaseUnavailable],
        }),
      },
    });

    const ready = await fetch(`${hz.base}/api/ready`);

    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: 'not_ready',
      reasons: ['database_unavailable'],
    });
  });

  it('keeps liveness up but rejects readiness and new intake while draining', async () => {
    const drainState = new DrainState();
    drainState.begin();
    const hz = await startHarness({ drainState });

    const live = await fetch(`${hz.base}/api/live`);
    const ready = await fetch(`${hz.base}/api/ready`);
    const intake = await fetch(`${hz.base}/api/fixtures`, { headers: authed });

    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'not_ready', reasons: ['draining'] });
    expect(intake.status).toBe(503);
    expect(await intake.json()).toEqual({ error: 'draining' });
  });

  it('serves the group snapshot with SOL markets and pots (no leaderboard)', async () => {
    const hz = await startHarness();
    const res = await fetch(`${hz.base}/api/groups/${CHAT_ID}/snapshot`, { headers: authed });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      markets: Array<{ currency: string; matchedPct: number; forSol: string }>;
      leaderboard?: unknown;
    };
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0]?.currency).toBe('sol');
    expect(body.markets[0]).toHaveProperty('matchedPct');
    expect(body.markets[0]).toHaveProperty('forSol');
    expect(body.leaderboard).toBeUndefined();
  });

  it('returns the wallet as a SOL stack with the linked pubkey', async () => {
    const hz = await startHarness();
    const res = await fetch(`${hz.base}/api/groups/${CHAT_ID}/users/${USER_ID}/wallet`, { headers: authed });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linkedWallet: string; balanceSol: string; balanceLamports: string };
    expect(body.linkedWallet).toBe(PUBKEY);
    expect(body.balanceLamports).toBe('1000000000');
    expect(body.balanceSol).toBe('1');
  });

  it('places a SOL bet over HTTP and escrows it in the wager ledger', async () => {
    const hz = await startHarness();
    const res = await fetch(`${hz.base}/api/stake`, { method: 'POST', headers: authed, body: stakeBody() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { placed: boolean; reply: string };
    expect(body.placed).toBe(true);
    expect(hz.wagerDb.positions).toHaveLength(1);
    // 0.05 SOL → 50_000_000 lamports.
    expect(hz.wagerDb.positions[0]).toMatchObject({ stake: 50_000_000, side: 'back', user_id: USER_ID });
    expect(hz.wagerDb.ledger.find((e) => e.kind === 'stake')?.lamports).toBe(-50_000_000n);
  });

  it('replaying the same idempotency key never double-stakes (eve step re-run)', async () => {
    const hz = await startHarness();
    const first = await fetch(`${hz.base}/api/stake`, { method: 'POST', headers: authed, body: stakeBody({ idempotencyKey: 'call-dup-1' }) });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { placed: boolean }).placed).toBe(true);
    const second = await fetch(`${hz.base}/api/stake`, { method: 'POST', headers: authed, body: stakeBody({ idempotencyKey: 'call-dup-1' }) });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { placed: boolean }).placed).toBe(false);
    expect(hz.wagerDb.positions).toHaveLength(1); // no double-stake
  });

  it('rejects negative, zero, and over-cap amounts at the schema (400)', async () => {
    const hz = await startHarness();
    for (const amount of [-0.05, 0, 0.5]) {
      const res = await fetch(`${hz.base}/api/stake`, {
        method: 'POST',
        headers: authed,
        body: stakeBody({ amount, idempotencyKey: `call-bad-${amount}` }),
      });
      expect(res.status).toBe(400);
    }
    expect(hz.wagerDb.positions).toHaveLength(0);
  });

  it('relays an insufficient-balance refusal as 200 { placed:false }', async () => {
    const hz = await startHarness({ balanceLamports: 1_000_000n }); // 0.001 SOL
    const res = await fetch(`${hz.base}/api/stake`, { method: 'POST', headers: authed, body: stakeBody({ idempotencyKey: 'call-poor-1' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { placed: boolean; reply: string };
    expect(body.placed).toBe(false);
    expect(body.reply.toLowerCase()).toContain('sol');
    expect(hz.wagerDb.positions).toHaveLength(0);
  });

  it('404s an unknown market and 409s a closed one', async () => {
    const hz = await startHarness({ market: { ...MARKET, status: 'settled' } });
    const unknown = await fetch(`${hz.base}/api/stake`, {
      method: 'POST',
      headers: authed,
      body: stakeBody({ marketId: '99999999-2222-4333-8444-555555555555', idempotencyKey: 'call-unk-1' }),
    });
    expect(unknown.status).toBe(404);
    const closed = await fetch(`${hz.base}/api/stake`, { method: 'POST', headers: authed, body: stakeBody({ idempotencyKey: 'call-closed-1' }) });
    expect(closed.status).toBe(409);
  });

  it('forwards a telegram update into the injected handler', async () => {
    const hz = await startHarness();
    const no = await fetch(`${hz.base}/api/telegram-update`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ update_id: 1, message: { text: 'hi' } }),
    });
    expect(no.status).toBe(409);
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
    expect(hz.wagerDb.positions).toHaveLength(0);
  });
});
