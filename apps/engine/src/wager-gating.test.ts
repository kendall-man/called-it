/**
 * Wager-mode gating compliance: with the flag OFF (deps.wager === null) a
 * full claim → stake → settle cycle must be byte-identical to main —
 * zero wager DB calls, zero deny-listed vocabulary, market inserts without a
 * currency key — and the seed/topup paths must never touch wager ledgers.
 * This is the whole point of the seams slice: deleting the wager module
 * restores main behavior.
 */

import { describe, expect, it } from 'vitest';
import type { Context } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import type { MarketSpec, MatchEvent } from '@calledit/market-engine';
import { DENIED_COPY_PATTERNS } from '@calledit/market-engine/testkit';
import { dispatchCallback } from './bot/callbacks.js';
import { renderFallback } from './bot/copy.js';
import type { Say } from './bot/copy.js';
import type { HandlerCtx } from './bot/context.js';
import { ensureUserSeen } from './bot/context.js';
import type { PostOptions } from './bot/poster.js';
import type { Poster } from './bot/poster.js';
import type { ParseEnvelope } from './pipeline/claims.js';
import { Settler } from './settle/settler.js';
import { runMatchdayTopup } from './cron/index.js';
import { settingsKeyboard, stakeKeyboard } from './bot/keyboards.js';
import type {
  ClaimRow,
  Deps,
  EngineDb,
  FixtureRow,
  GroupRow,
  LedgerEntry,
  MarketRow,
  PositionRow,
} from './ports.js';

const NOW = Date.parse('2026-07-03T18:00:00.000Z');
const CHAT_ID = -100123;
const CLAIMER_ID = 7001;
const STAKER_ID = 7002;
const CLAIM_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const FIXTURE_ID = 42;

const REP_LEDGER_KINDS = new Set(['stake', 'payout', 'refund', 'topup', 'seed']);

function repSpec(): MarketSpec {
  return {
    claimType: 'match_winner',
    fixtureId: FIXTURE_ID,
    entityRef: { kind: 'team', participant: 1, name: 'Egypt' },
    comparator: 'gte',
    threshold: 1,
    period: 'FT_90',
    trustTier: 'oracle_resolved',
  };
}

const FIXTURE: FixtureRow = {
  fixture_id: FIXTURE_ID,
  p1_name: 'Egypt',
  p2_name: 'Ghana',
  kickoff_at: new Date(NOW + 60 * 60_000).toISOString(),
  phase: 'NS',
  minute: null,
  last_seq: 0,
  score: {},
  coverage_unreliable: false,
};

const GROUP: GroupRow = {
  id: CHAT_ID,
  title: 'Sunday Legends',
  slug: 'sunday-legends',
  web_enabled: true,
  chattiness: 'nudge',
  is_admin: true,
};

function confirmedClaim(): ClaimRow {
  const envelope: ParseEnvelope = {
    raw: null,
    kind: 'ok',
    options: [{ key: 'ok', label: 'As stated', spec: repSpec() }],
    chosen: repSpec(),
    quote: {
      probability: 0.6,
      multiplier: 1.6,
      provenance: 'market',
      oddsMessageId: 'om-1',
      oddsTsMs: NOW - 1000,
    },
  };
  return {
    id: CLAIM_ID,
    group_id: CHAT_ID,
    claimer_user_id: CLAIMER_ID,
    tg_message_id: 555,
    quoted_text: 'Egypt win this',
    status: 'awaiting_confirm',
    classifier_confidence: 0.9,
    parse: envelope,
    expires_at: new Date(NOW + 5 * 60_000).toISOString(),
    created_at: new Date(NOW - 60_000).toISOString(),
  };
}

interface Harness {
  h: HandlerCtx;
  deps: Deps;
  poster: Poster;
  say: Say;
  posts: Array<{ chatId: number; text: string }>;
  /** Every DB method name invoked, in order. */
  dbCalls: Array<{ method: string; args: unknown[] }>;
  ledger: LedgerEntry[];
  markets: MarketRow[];
  positions: PositionRow[];
  /** The literal input objects handed to insertMarket. */
  marketInserts: Array<Record<string, unknown>>;
}

function makeHarness(options: { balance?: number } = {}): Harness {
  let claim = confirmedClaim();
  const posts: Array<{ chatId: number; text: string }> = [];
  const dbCalls: Array<{ method: string; args: unknown[] }> = [];
  const ledger: LedgerEntry[] = [];
  const markets: MarketRow[] = [];
  const positions: PositionRow[] = [];
  const marketInserts: Array<Record<string, unknown>> = [];
  const seededMemberships = new Set<string>();
  const settlements: Array<{ market_id: string; outcome: string }> = [];

  const dbBase = {
    getClaim: async (id: string) => (id === claim.id ? { ...claim } : null),
    updateClaim: async (_id: string, patch: Partial<ClaimRow>) => {
      claim = { ...claim, ...patch } as ClaimRow;
    },
    getGroup: async (id: number) => (id === CHAT_ID ? GROUP : null),
    getUser: async (id: number) =>
      id === CLAIMER_ID
        ? { id, display_name: 'Dee', username: 'dee' }
        : { id, display_name: 'Mo', username: 'mo' },
    upsertUser: async () => undefined,
    ensureMembership: async (groupId: number, userId: number) => {
      const key = `${groupId}:${userId}`;
      const created = !seededMemberships.has(key);
      seededMemberships.add(key);
      return { created };
    },
    balance: async () => options.balance ?? TUNABLES.STARTING_BALANCE,
    listGroups: async () => [GROUP],
    listMemberships: async () => [
      { group_id: CHAT_ID, user_id: STAKER_ID, points_cached: 0, streak: 0 },
    ],
    postLedger: async (entry: LedgerEntry) => {
      if (ledger.some((existing) => existing.idempotency_key === entry.idempotency_key)) {
        return { inserted: false };
      }
      ledger.push(entry);
      return { inserted: true };
    },
    getFixture: async () => FIXTURE,
    playersForFixture: async () => [],
    openMarketsForGroup: async () => markets.filter((m) => m.status === 'open'),
    openMarketsForFixture: async () =>
      markets.filter((m) => m.status === 'open' || m.status === 'pending_lineup'),
    insertMarket: async (input: Record<string, unknown>) => {
      marketInserts.push(input);
      const market = {
        ...input,
        id: `0f14d0ab-9605-4a62-a9e4-5ed26688389${markets.length}`,
        card_tg_message_id: null,
        created_at: new Date(NOW).toISOString(),
      } as unknown as MarketRow;
      markets.push(market);
      return market;
    },
    getMarket: async (id: string) => markets.find((m) => m.id === id) ?? null,
    updateMarketStatus: async (id: string, status: MarketRow['status']) => {
      const market = markets.find((m) => m.id === id);
      if (market) market.status = status;
    },
    setMarketCardMessage: async () => undefined,
    insertPosition: async (input: Record<string, unknown>) => {
      const position = {
        ...input,
        id: `b7e23ec2-9605-4a62-a9e4-5ed26688389${positions.length}`,
      } as unknown as PositionRow;
      positions.push(position);
      return position;
    },
    positionsForMarket: async (marketId: string) =>
      positions.filter((p) => p.market_id === marketId),
    setPositionStates: async (ids: string[], state: PositionRow['state']) => {
      for (const position of positions) {
        if (ids.includes(position.id)) position.state = state;
      }
    },
    insertFeedEvent: async () => ({ inserted: true }),
    updateFixtureFromEvent: async () => undefined,
    insertSettlement: async (input: { market_id: string; outcome: string }) => {
      settlements.push(input);
    },
    markSettlementPosted: async () => undefined,
  };

  // Record EVERY db method invocation so the test can prove zero wager calls.
  const db = new Proxy(dbBase, {
    get(target, prop: string) {
      const fn = (target as Record<string, unknown>)[prop];
      if (typeof fn !== 'function') return fn;
      return (...args: unknown[]) => {
        dbCalls.push({ method: prop, args });
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as unknown as EngineDb;

  const deps = {
    db,
    agent: {},
    engine: {
      priceSpec: () => ({
        probability: 0.6,
        multiplier: 1.6,
        provenance: 'market' as const,
        oddsMessageId: 'om-1',
        oddsTsMs: NOW - 1000,
      }),
      // The reducer immediately settles: exercises the full Rep settle path.
      reduceMarket: (state: { status: string }) => ({
        state: { ...state, status: 'settled' },
        effects: [
          { kind: 'settle' as const, outcome: 'claim_won' as const, decidingSeq: 7, evidenceSeqs: [7] },
        ],
      }),
      checkDebounce: (state: unknown) => ({ state, effects: [] }),
    },
    tx: {
      fetchOdds: async () =>
        ({
          kind: 'ok',
          odds: {
            p1x2: { home: 0.6, draw: 0.25, away: 0.15 },
            totals: { line: 2.5, overProb: 0.55 },
            oddsMessageId: 'om-1',
            oddsTsMs: NOW - 1000,
          },
        }) as const,
    },
    proofSubmitter: null,
    wager: null,
    env: { WEB_BASE_URL: 'https://web.test' },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => NOW,
  } as unknown as Deps;

  const poster = {
    post: (chatId: number, text: string, _options: PostOptions = {}) => {
      posts.push({ chatId, text });
    },
    editCard: (_chatId: number, _marketId: string, _messageId: number, text: string) => {
      posts.push({ chatId: CHAT_ID, text });
    },
    stripKeyboard: () => undefined,
  } as unknown as Poster;

  const say: Say = async (key, vars = {}) => renderFallback(key, vars);

  const h = {
    deps,
    poster,
    say,
    supervisor: { replayFixture: () => null },
    budget: { allow: () => true },
  } as unknown as HandlerCtx;

  return { h, deps, poster, say, posts, dbCalls, ledger, markets, positions, marketInserts };
}

function fakeCtx(userId: number): { ctx: Context; toasts: string[] } {
  const toasts: string[] = [];
  const ctx = {
    chat: { id: CHAT_ID },
    from: { id: userId, first_name: userId === CLAIMER_ID ? 'Dee' : 'Mo' },
    answerCallbackQuery: async (payload: { text: string }) => {
      toasts.push(payload.text);
    },
  } as unknown as Context;
  return { ctx, toasts };
}

function expectCleanCopy(texts: string[]): void {
  for (const text of texts) {
    for (const pattern of DENIED_COPY_PATTERNS) {
      expect(pattern.test(text), `deny-listed copy (${pattern}): "${text}"`).toBe(false);
    }
  }
}

describe('flag-off gating: full claim → stake → settle cycle', () => {
  it('runs the whole cycle with zero wager DB calls, wager-free ledger keys, and clean copy', async () => {
    const harness = makeHarness();

    // 1. Confirm tap mints the market.
    const confirmTap = fakeCtx(CLAIMER_ID);
    await dispatchCallback(harness.h, confirmTap.ctx, { t: 'confirm', claimId: CLAIM_ID });
    expect(harness.markets).toHaveLength(1);
    const market = harness.markets[0]!;

    // The insert input must be main-identical: NO currency key when the
    // module is null (works unchanged against a pre-0002 schema).
    expect(Object.keys(harness.marketInserts[0]!)).not.toContain('currency');

    // 2. Stake tap (first touch also seeds the member).
    const stakeTap = fakeCtx(STAKER_ID);
    await dispatchCallback(harness.h, stakeTap.ctx, {
      t: 'stake',
      marketId: market.id,
      side: 'back',
      presetIndex: 0,
    });
    expect(harness.positions).toHaveLength(1);

    // 3. A feed event settles the market through the Rep path.
    const settler = new Settler(harness.deps, harness.poster, harness.say, null);
    const goal = {
      fixtureId: FIXTURE_ID,
      seq: 7,
      kind: 'goal',
      confirmed: true,
      minute: 63,
      detail: { playerName: 'Salah' },
    } as unknown as MatchEvent;
    await settler.onEvent(goal);
    expect(market.status).toBe('settled');

    // Zero wager anything in the DB traffic.
    const methodNames = harness.dbCalls.map((call) => call.method);
    expect(methodNames.some((name) => /wager/i.test(name))).toBe(false);

    // Ledger entries are Rep-shaped only: known kinds, main-identical keys.
    expect(harness.ledger.length).toBeGreaterThanOrEqual(3); // seed + stake + payout
    for (const entry of harness.ledger) {
      expect(REP_LEDGER_KINDS.has(entry.kind)).toBe(true);
      expect(entry.idempotency_key.startsWith('wager:')).toBe(false);
      expect(/^(seed|stake|payout|refund|topup):/.test(entry.idempotency_key)).toBe(true);
    }
    const kinds = harness.ledger.map((entry) => entry.kind);
    expect(kinds).toContain('seed');
    expect(kinds).toContain('stake');
    expect(kinds).toContain('payout');

    // Every string a group member could read is deny-list clean.
    expectCleanCopy([
      ...harness.posts.map((post) => post.text),
      ...confirmTap.toasts,
      ...stakeTap.toasts,
    ]);
  });

  it('renders main-identical keyboards when the module is off', () => {
    // Stake presets: Rep numbers, unchanged callback encoding.
    const marketId = '0f14d0ab-9605-4a62-a9e4-5ed26688389b';
    const keyboard = stakeKeyboard(marketId).inline_keyboard.flat();
    const labels = keyboard.map((button) => button.text);
    for (const [index, amount] of TUNABLES.PRESET_STAKES.entries()) {
      expect(labels).toContain(`⚡ Back ${amount}`);
      expect(labels).toContain(`🛑 Doubt ${amount}`);
      const data = keyboard.map((b) => ('callback_data' in b ? b.callback_data : ''));
      expect(data).toContain(`st:${marketId}:b:${index}`);
      expect(data).toContain(`st:${marketId}:d:${index}`);
    }
    expectCleanCopy(labels);

    // Settings keyboard: no devnet-SOL row without a live module.
    const settings = settingsKeyboard('nudge', true).inline_keyboard.flat();
    expect(settings.some((button) => button.text.includes('SOL'))).toBe(false);
    expect(settings).toHaveLength(4);
  });
});

describe('flag-off gating: seed and topup isolation', () => {
  it('first-touch seeding posts only a Rep seed entry and no wager calls', async () => {
    const harness = makeHarness();
    await ensureUserSeen(harness.h, CHAT_ID, {
      id: STAKER_ID,
      is_bot: false,
      first_name: 'Mo',
    } as Parameters<typeof ensureUserSeen>[2]);

    expect(harness.ledger).toHaveLength(1);
    expect(harness.ledger[0]!.kind).toBe('seed');
    expect(harness.ledger[0]!.idempotency_key).toBe(`seed:${CHAT_ID}:${STAKER_ID}`);
    expect(harness.dbCalls.some((call) => /wager/i.test(call.method))).toBe(false);
  });

  it('matchday topup posts only Rep topup entries and no wager calls', async () => {
    // Member below the floor so the topup actually posts an entry.
    const harness = makeHarness({ balance: TUNABLES.MATCHDAY_TOPUP_FLOOR - 100 });
    await runMatchdayTopup(harness.deps);

    expect(harness.ledger.length).toBeGreaterThan(0);
    for (const entry of harness.ledger) {
      expect(entry.kind).toBe('topup');
      expect(entry.idempotency_key.startsWith('topup:')).toBe(true);
    }
    expect(harness.dbCalls.some((call) => /wager/i.test(call.method))).toBe(false);
  });
});
