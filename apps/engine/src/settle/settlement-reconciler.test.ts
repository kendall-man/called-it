import { describe, expect, it } from 'vitest';
import { checkDebounce, reduceMarket, type MatchEvent } from '@calledit/market-engine';
import type { FixtureRow, MarketRow, PositionRow } from '../ports.js';
import { SettlementReconciler } from './settlement-reconciler.js';

const NOW = Date.parse('2026-07-11T21:01:00.000Z');
const FIXTURE_ID = 18_213_979;
const MARKET_ID = 'e04f9cc7-2cc1-4f58-9f93-f5ad46d7a228';

const fixture: FixtureRow = {
  fixture_id: FIXTURE_ID,
  p1_name: 'Norway',
  p2_name: 'England',
  kickoff_at: '2026-07-11T21:00:00.000Z',
  phase: 'H2',
  minute: 90,
  last_seq: 40,
  score: {},
  coverage_unreliable: false,
};

const market: MarketRow = {
  id: MARKET_ID,
  claim_id: '10000000-0000-4000-8000-000000000001',
  group_id: -1004358786177,
  fixture_id: FIXTURE_ID,
  spec: {
    claimType: 'match_winner',
    fixtureId: FIXTURE_ID,
    entityRef: { kind: 'team', name: 'Norway', participant: 1 },
    comparator: 'gte',
    threshold: 1,
    period: 'FT',
    trustTier: 'chain_proven',
  },
  status: 'open',
  is_replay: false,
  price_provenance: 'modelled',
  quote_probability: 0.330327,
  quote_multiplier: 3.0273,
  odds_message_id: null,
  odds_ts: null,
  card_tg_message_id: 100,
  created_at: '2026-07-11T10:03:15.000Z',
  currency: 'sol',
  custody_mode: 'legacy',
};

const position: PositionRow = {
  id: '59097562-cb10-4457-a573-a690790b4fdf',
  market_id: MARKET_ID,
  user_id: 572423839,
  side: 'back',
  stake: 10_000_000,
  locked_multiplier: 3.0273,
  state: 'active',
  placed_at_ms: NOW - 1_000,
};

const finalEvent: MatchEvent = {
  kind: 'phase_change',
  fixtureId: FIXTURE_ID,
  seq: 41,
  tsMs: NOW - 500,
  receivedAtMs: NOW - 91_000,
  confirmed: true,
  phase: 'F',
  minute: 90,
  score: {
    p1: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
    p2: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
    p1Goals90: 1,
    p2Goals90: 0,
  },
};

describe('SettlementReconciler', () => {
  it.each(['sol', 'usdc'] as const)(
    'settles and financially applies a terminal %s snapshot once',
    async (currency) => {
    const statuses: string[] = [];
    const settlements: Array<{ readonly outcome: string; readonly deciding_seq: number | null }> = [];
    const applied: string[] = [];
    const presented: string[] = [];
    const reconciler = new SettlementReconciler({
      db: {
        liveFixtures: async () => [fixture],
        openMarketsForFixture: async () => [{ ...market, currency }],
        positionsForMarket: async () => [position],
        insertFeedEvent: async () => ({ inserted: false }),
        updateFixtureFromEvent: async () => undefined,
        updateMarketStatus: async (_marketId, status) => { statuses.push(status); },
        insertSettlement: async (settlement) => {
          settlements.push({
            outcome: settlement.outcome,
            deciding_seq: settlement.deciding_seq,
          });
        },
      },
      fetchScoreEvents: async () => [finalEvent],
      reduceMarket,
      checkDebounce,
      applySettlement: async (marketId) => { applied.push(marketId); },
      presentTerminal: async (terminalMarket) => { presented.push(terminalMarket.id); },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => NOW,
      lookaheadMs: 15 * 60_000,
    });

    await reconciler.tick();
    await reconciler.tick();

    expect(statuses).toEqual(['settled']);
    expect(settlements).toEqual([{ outcome: 'claim_won', deciding_seq: 41 }]);
    expect(applied).toEqual([MARKET_ID]);
    expect(presented).toEqual([MARKET_ID]);
    await expect(reconciler.feedSnapshot()).resolves.toEqual({
      activePricingExpected: true,
      lastEventAtMs: NOW,
    });
    await expect(reconciler.snapshot()).resolves.toEqual({
      enabled: true,
      heartbeatAtMs: NOW,
      backlog: 0,
      oldestAgeMs: null,
    });
    },
  );

  it('advances the fixture from a non-terminal score snapshot without settling', async () => {
    const liveEvent: MatchEvent = {
      ...finalEvent,
      seq: 40,
      phase: 'H1',
      minute: 1,
      score: {
        ...finalEvent.score,
        p1: { ...finalEvent.score.p1, goals: 0 },
      },
    };
    const updated: number[] = [];
    const settlements: string[] = [];
    const reconciler = new SettlementReconciler({
      db: {
        liveFixtures: async () => [fixture],
        openMarketsForFixture: async () => [market],
        positionsForMarket: async () => [position],
        insertFeedEvent: async () => ({ inserted: true }),
        updateFixtureFromEvent: async (event) => { updated.push(event.seq); },
        updateMarketStatus: async () => undefined,
        insertSettlement: async (settlement) => { settlements.push(settlement.outcome); },
      },
      fetchScoreEvents: async () => [liveEvent],
      reduceMarket,
      checkDebounce,
      applySettlement: async () => undefined,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => NOW,
      lookaheadMs: 15 * 60_000,
    });

    await reconciler.tick();

    expect(updated).toEqual([40]);
    expect(settlements).toEqual([]);
  });
});
