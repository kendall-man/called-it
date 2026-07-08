/**
 * Behavior tests for the SOL stake path (handleStake via dispatchCallback).
 * Every market is a SOL market now: handleStake resolves the preset index to
 * lamports and delegates to the wager module (which owns funds, gates, copy).
 * These pin the callback-level behavior — preset→lamports, non-sol/closed
 * guards, the in-play cutoff, and the card refresh on a placed bet.
 */

import { describe, expect, it } from 'vitest';
import type { Context } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import { dispatchCallback } from './callbacks.js';
import { renderFallback } from './copy.js';
import type { HandlerCtx } from './context.js';
import type { EngineDb, FixtureRow, MarketRow } from '../ports.js';
import { LlmBudget } from './budget.js';
import { createWagerModule } from '../wager/module.js';
import { makeFakeDeps, type FakeWagerDb } from '../wager/fakes.js';

const NOW = Date.parse('2026-07-06T18:00:00.000Z');
const CHAT_ID = -100999;
const USER_A = 8001;
const MARKET_ID = 'a1111111-1111-4111-8111-111111111111';
const FIXTURE_ID = 77;

const PRESET_01 = 0; // 0.01 SOL = 10_000_000 lamports
const PRESET_05 = 1; // 0.05 SOL = 50_000_000
const PRESET_10 = 2; // 0.1 SOL = 100_000_000

function fixtureAt(phase: string, minute: number | null): FixtureRow {
  return {
    fixture_id: FIXTURE_ID,
    p1_name: 'Brazil',
    p2_name: 'Norway',
    competition_id: null,
    p1_id: null,
    p2_id: null,
    kickoff_at: new Date(NOW + 3_600_000).toISOString(),
    phase,
    minute,
    last_seq: 0,
    score: {},
    coverage_unreliable: false,
  } as unknown as FixtureRow;
}

function market(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: MARKET_ID,
    claim_id: 'claim-1',
    group_id: CHAT_ID,
    fixture_id: FIXTURE_ID,
    spec: { claimType: 'match_winner' } as MarketRow['spec'],
    status: 'open',
    is_replay: false,
    price_provenance: 'market',
    quote_probability: 0.5,
    quote_multiplier: 2,
    odds_message_id: 'om-1',
    odds_ts: NOW - 1000,
    card_tg_message_id: null, // null ⇒ refreshStakeCard is a no-op
    created_at: new Date(NOW).toISOString(),
    currency: 'sol',
    ...overrides,
  } as MarketRow;
}

interface StakeHarness {
  h: HandlerCtx;
  wagerDb: FakeWagerDb;
}

function makeHarness(
  opts: { marketRow?: MarketRow; fixture?: FixtureRow; balanceLamports?: bigint; link?: boolean } = {},
): StakeHarness {
  const wagerBundle = makeFakeDeps({ now: () => NOW });
  const wager = createWagerModule(wagerBundle.deps);
  if (opts.link ?? true) wagerBundle.db.seedLink(USER_A, 'Wa11etPubkey1111111111111111111111111111');
  wagerBundle.db.seedBalance(USER_A, opts.balanceLamports ?? 1_000_000_000n); // default 1 SOL
  wagerBundle.db.seedMarketProbability(MARKET_ID, 0.5);

  const theMarket = opts.marketRow ?? market();
  const theFixture = opts.fixture ?? fixtureAt('NS', null);
  const db = {
    getMarket: async (id: string) => (id === theMarket.id ? { ...theMarket } : null),
    getFixture: async () => theFixture,
    getUser: async (id: number) => ({ id, display_name: `U${id}`, username: null }),
    upsertUser: async () => undefined,
    ensureMembership: async () => ({ created: false }),
    getClaim: async () => null,
    getGroup: async () => ({ id: CHAT_ID, slug: 'g', title: 'G', web_enabled: true }),
    positionsForMarket: async () => [],
    setMarketCardMessage: async () => undefined,
  } as unknown as EngineDb;

  const h = {
    deps: {
      db,
      wager,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => NOW,
      env: { WEB_BASE_URL: 'https://web.test' },
    },
    poster: { post: () => undefined, editCard: () => undefined, stripKeyboard: () => undefined },
    say: async (key: Parameters<typeof renderFallback>[0], vars = {}) => renderFallback(key, vars),
    supervisor: { replayFixture: () => null },
    budget: new LlmBudget(1000, () => NOW),
  } as unknown as HandlerCtx;

  return { h, wagerDb: wagerBundle.db };
}

function stakeCtx(userId: number): { ctx: Context; toasts: string[] } {
  const toasts: string[] = [];
  const ctx = {
    chat: { id: CHAT_ID },
    from: { id: userId, first_name: `U${userId}` },
    answerCallbackQuery: async (payload: { text: string }) => {
      toasts.push(payload.text);
    },
  } as unknown as Context;
  return { ctx, toasts };
}

const stake = (side: 'back' | 'doubt', presetIndex: number) =>
  ({ t: 'stake', marketId: MARKET_ID, side, presetIndex }) as const;

describe('handleStake — SOL delegate', () => {
  it('resolves the preset index to lamports and places one position', async () => {
    const hz = makeHarness();
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(1);
    // 0.05 SOL preset → 50_000_000 lamports (stored as a JS number on the row).
    expect(hz.wagerDb.positions[0]).toMatchObject({ side: 'back', stake: 50_000_000, user_id: USER_A });
    expect(toasts).toHaveLength(1);
  });

  it('maps each preset index to the right lamport amount', async () => {
    for (const [index, lamports] of [
      [PRESET_01, 10_000_000],
      [PRESET_05, 50_000_000],
      [PRESET_10, 100_000_000],
    ] as const) {
      const hz = makeHarness();
      const { ctx } = stakeCtx(USER_A);
      await dispatchCallback(hz.h, ctx, stake('back', index));
      expect(hz.wagerDb.positions[0]?.stake).toBe(lamports);
    }
  });

  it('treats a non-SOL market as a stale tap (no Rep path exists)', async () => {
    const hz = makeHarness({ marketRow: market({ currency: 'rep' }) });
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(0);
    expect(toasts).toContain(renderFallback('stale'));
  });

  it('refuses a stake once the match is past the in-play cutoff', async () => {
    const hz = makeHarness({ fixture: fixtureAt('2H', TUNABLES.INPLAY_STAKE_CUTOFF_MINUTE) });
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(0);
    expect(toasts).toContain(renderFallback('window_closed'));
  });

  it('reports a closed market with its status line', async () => {
    const hz = makeHarness({ marketRow: market({ status: 'settled' }) });
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(0);
    expect(toasts.some((t) => t.toLowerCase().includes('settled'))).toBe(true);
  });

  it('onboards an unlinked member instead of placing a bet', async () => {
    const hz = makeHarness({ link: false });
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(0);
    expect(toasts.some((t) => t.toLowerCase().includes('/wallet'))).toBe(true);
  });

  it('relays an insufficient-balance refusal from the wager desk', async () => {
    const hz = makeHarness({ balanceLamports: 1_000_000n }); // 0.001 SOL < 0.05 preset
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(0);
    expect(toasts.some((t) => t.toLowerCase().includes('sol'))).toBe(true);
  });
});
