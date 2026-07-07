/**
 * Behavior tests for the staking money path (handleStake via dispatchCallback).
 * The path had zero coverage; these pin the guards a conversational-amount
 * refactor must not regress — and the per-(market,user) lock that stops a
 * concurrent double-stake from bypassing the cap / going negative.
 */

import { describe, expect, it } from 'vitest';
import type { Context } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import { dispatchCallback } from './callbacks.js';
import { renderFallback } from './copy.js';
import type { HandlerCtx } from './context.js';
import type { EngineDb, FixtureRow, LedgerEntry, MarketRow, PositionRow } from '../ports.js';
import { LlmBudget } from './budget.js';

const NOW = Date.parse('2026-07-06T18:00:00.000Z');
const CHAT_ID = -100999;
const USER_A = 8001;
const MARKET_ID = 'mkt-stake-1';
const FIXTURE_ID = 77;

const PRESET_25 = 0; // TUNABLES.PRESET_STAKES = [25, 50, 100]
const PRESET_50 = 1;
const PRESET_100 = 2;

const NS_FIXTURE: FixtureRow = {
  fixture_id: FIXTURE_ID,
  p1_name: 'Brazil',
  p2_name: 'Norway',
  competition_id: null,
  p1_id: null,
  p2_id: null,
  kickoff_at: new Date(NOW + 3_600_000).toISOString(),
  phase: 'NS',
  minute: null,
  last_seq: 0,
  score: {},
  coverage_unreliable: false,
} as unknown as FixtureRow;

const MARKET: MarketRow = {
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
  card_tg_message_id: null,
  created_at: new Date(NOW).toISOString(),
};

interface StakeHarness {
  h: HandlerCtx;
  positions: PositionRow[];
  ledger: LedgerEntry[];
}

function makeStakeHarness(opts: { startingBalance?: number; seedPositions?: PositionRow[] } = {}): StakeHarness {
  const positions: PositionRow[] = [...(opts.seedPositions ?? [])];
  const ledger: LedgerEntry[] = [];
  const startingBalance = opts.startingBalance ?? TUNABLES.STARTING_BALANCE;
  let seq = positions.length;

  const db = {
    getMarket: async (id: string) => (id === MARKET_ID ? { ...MARKET } : null),
    getFixture: async () => NS_FIXTURE,
    getUser: async (id: number) => ({ id, display_name: `U${id}`, username: null }),
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
    balance: async (_g: number, userId: number) =>
      startingBalance + ledger.filter((e) => e.user_id === userId).reduce((s, e) => s + e.amount, 0),
    setMarketCardMessage: async () => undefined,
  } as unknown as EngineDb;

  const h = {
    deps: {
      db,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => NOW,
      env: { WEB_BASE_URL: 'https://web.test' },
    },
    poster: { post: () => undefined, editCard: () => undefined, stripKeyboard: () => undefined },
    say: async (key: Parameters<typeof renderFallback>[0], vars = {}) => renderFallback(key, vars),
    supervisor: { replayFixture: () => null },
    budget: new LlmBudget(1000, () => NOW),
  } as unknown as HandlerCtx;

  return { h, positions, ledger };
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

describe('handleStake — money path', () => {
  it('places one position and debits the stake', async () => {
    const hz = makeStakeHarness();
    const { ctx } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_50));
    expect(hz.positions).toHaveLength(1);
    expect(hz.positions[0]).toMatchObject({ side: 'back', stake: 50, user_id: USER_A });
    // ledger debit is the NEGATION of the stake
    expect(hz.ledger.filter((e) => e.kind === 'stake')).toHaveLength(1);
    expect(hz.ledger.find((e) => e.kind === 'stake')?.amount).toBe(-50);
  });

  it('serializes concurrent double-stakes → exactly one position (the lock)', async () => {
    const hz = makeStakeHarness();
    const a = stakeCtx(USER_A);
    const b = stakeCtx(USER_A);
    await Promise.all([
      dispatchCallback(hz.h, a.ctx, stake('back', PRESET_100)),
      dispatchCallback(hz.h, b.ctx, stake('back', PRESET_100)),
    ]);
    // Without the lock both would insert (cap bypassed, balance overdrawn).
    expect(hz.positions).toHaveLength(1);
    const heldOff = [...a.toasts, ...b.toasts].some((t) => t === renderFallback('hold_on'));
    expect(heldOff).toBe(true);
  });

  it('rejects the opposite side when already staked — pick a lane', async () => {
    const hz = makeStakeHarness({
      seedPositions: [
        { id: 'pos-0', market_id: MARKET_ID, user_id: USER_A, side: 'back', stake: 25, locked_multiplier: 2, state: 'active', placed_at_ms: NOW },
      ],
    });
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('doubt', PRESET_25));
    expect(hz.positions).toHaveLength(1); // no new position
    expect(toasts.some((t) => t.includes('lane'))).toBe(true);
  });

  it('rejects a stake that would exceed the per-market cap', async () => {
    const hz = makeStakeHarness({
      seedPositions: [
        { id: 'pos-0', market_id: MARKET_ID, user_id: USER_A, side: 'back', stake: 25, locked_multiplier: 2, state: 'active', placed_at_ms: NOW },
      ],
    });
    const { ctx, toasts } = stakeCtx(USER_A);
    // 25 committed + 100 preset = 125 > cap(100)
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_100));
    expect(hz.positions).toHaveLength(1);
    expect(toasts.some((t) => t.toLowerCase().includes('maxed') || t.toLowerCase().includes('ceiling'))).toBe(true);
  });

  it('rejects a stake beyond the balance', async () => {
    const hz = makeStakeHarness({ startingBalance: 10 });
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_25));
    expect(hz.positions).toHaveLength(0);
    expect(toasts.some((t) => t.toLowerCase().includes('rep'))).toBe(true);
  });
});
