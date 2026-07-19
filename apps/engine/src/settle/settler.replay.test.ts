import { describe, expect, it } from 'vitest';
import type { MatchEvent, MarketState } from '@calledit/market-engine';
import type { Deps, MarketRow } from '../ports.js';
import { Settler } from './settler.js';

const GROUP_ID = -100_700;
const FIXTURE_ID = 18_209_181;

function market(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: '00000000-0000-4000-8000-000000000701',
    claim_id: '00000000-0000-4000-8000-000000000601',
    group_id: GROUP_ID,
    fixture_id: FIXTURE_ID,
    spec: {
      claimType: 'match_winner',
      fixtureId: FIXTURE_ID,
      entityRef: { kind: 'team', participant: 1, name: 'France' },
      comparator: 'gte',
      threshold: 1,
      period: 'FT_90',
      trustTier: 'oracle_resolved',
    },
    status: 'open',
    is_replay: true,
    price_provenance: 'market',
    quote_probability: 0.6,
    quote_multiplier: 1.6,
    odds_message_id: 'odds-1',
    odds_ts: 1,
    card_tg_message_id: null,
    created_at: '2026-07-13T10:00:00.000Z',
    currency: 'sol',
    custody_mode: 'legacy',
    ...overrides,
  };
}

const EVENT: MatchEvent = {
  kind: 'phase_change',
  fixtureId: FIXTURE_ID,
  seq: 1,
  tsMs: Date.parse('2026-07-13T10:01:00.000Z'),
  receivedAtMs: Date.parse('2026-07-13T10:01:01.000Z'),
  confirmed: true,
  phase: 'H1',
  minute: 1,
  score: {
    p1: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
    p2: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
    p1Goals90: null,
    p2Goals90: null,
  },
};

describe('Settler replay isolation', () => {
  it('bypasses global event dedupe and reduces only replay markets in the requesting group', async () => {
    // Given one matching replay market plus a live and cross-group market
    const target = market();
    const live = market({ id: '00000000-0000-4000-8000-000000000702', is_replay: false });
    const otherGroup = market({
      id: '00000000-0000-4000-8000-000000000703',
      group_id: GROUP_ID - 1,
    });
    const staleRun = market({
      id: '00000000-0000-4000-8000-000000000704',
      created_at: '2026-07-13T09:59:59.000Z',
    });
    const reduced: string[] = [];
    const deps = {
      db: {
        openMarketsForFixture: async () => [target, live, otherGroup, staleRun],
        positionsForMarket: async () => [],
        insertFeedEvent: async () => { throw new Error('replay must not insert feed events'); },
        updateFixtureFromEvent: async () => { throw new Error('replay must not mutate fixtures'); },
      },
      engine: {
        reduceMarket(state: MarketState) {
          reduced.push(state.marketId);
          return { state, effects: [] };
        },
      },
      log: { info() {}, warn() {}, error() {}, child() { return this; } },
    } as unknown as Deps;
    const settler = new Settler(
      deps,
      { post() {}, editCard() {}, stripKeyboard() {} } as never,
      async () => '',
      { apply: async () => ({ eligible: false }) } as never,
      null,
    );

    // When an already-recorded historical event is replayed
    await settler.onReplayEvent(GROUP_ID, EVENT, Date.parse(target.created_at));

    // Then only the group-scoped replay market reaches the reducer
    expect(reduced).toEqual([target.id]);
  });

  it('keeps live feed corrections away from replay markets', async () => {
    const replay = market();
    const live = market({ id: '00000000-0000-4000-8000-000000000705', is_replay: false });
    const reduced: string[] = [];
    const deps = {
      db: {
        insertFeedEvent: async () => ({ inserted: true }),
        updateFixtureFromEvent: async () => undefined,
        openMarketsForFixture: async () => [replay, live],
        positionsForMarket: async () => [],
      },
      engine: {
        reduceMarket(state: MarketState) {
          reduced.push(state.marketId);
          return { state, effects: [] };
        },
      },
      log: { info() {}, warn() {}, error() {}, child() { return this; } },
    } as unknown as Deps;
    const settler = new Settler(
      deps,
      { post() {}, editCard() {}, stripKeyboard() {} } as never,
      async () => '',
      { apply: async () => ({ eligible: false }) } as never,
      null,
    );

    await settler.onEvent(EVENT);

    expect(reduced).toEqual([live.id]);
  });

  it('propagates replay persistence failure and retries from durable state', async () => {
    const target = market();
    let statusAttempts = 0;
    let settlements = 0;
    const deps = {
      db: {
        openMarketsForFixture: async () => [target],
        positionsForMarket: async () => [],
        updateMarketStatus: async () => {
          statusAttempts += 1;
          if (statusAttempts === 1) throw new Error('temporary database failure');
        },
        insertSettlement: async () => { settlements += 1; },
      },
      engine: {
        reduceMarket(state: MarketState) {
          return {
            state: { ...state, status: 'settled' as const },
            effects: [{
              kind: 'settle' as const,
              outcome: 'claim_won' as const,
              decidingSeq: EVENT.seq,
              evidenceSeqs: [EVENT.seq],
            }],
          };
        },
      },
      log: { info() {}, warn() {}, error() {}, child() { return this; } },
    } as unknown as Deps;
    const settler = new Settler(
      deps,
      { post() {}, editCard() {}, stripKeyboard() {} } as never,
      async () => '',
      { apply: async () => ({ eligible: false }) } as never,
      null,
    );
    settler.postReceipt = async () => undefined;

    await expect(settler.onReplayEvent(GROUP_ID, EVENT, 0)).rejects.toThrow('temporary database failure');
    await settler.onReplayEvent(GROUP_ID, EVENT, 0);

    expect(statusAttempts).toBe(2);
    expect(settlements).toBe(1);
  });

  it('keeps devnet replay settlement out of the starter and payout ledgers', async () => {
    // Given a replay market whose next historical event decides the call
    const target = market();
    let wagerSettlements = 0;
    const persisted: string[] = [];
    const receipts: string[] = [];
    const deps = {
      db: {
        openMarketsForFixture: async () => [target],
        positionsForMarket: async () => [],
        updateMarketStatus: async () => { persisted.push('status'); },
        insertSettlement: async () => { persisted.push('settlement'); },
        getClaim: async () => ({
          id: target.claim_id,
          group_id: GROUP_ID,
          claimer_user_id: 700,
          tg_message_id: 1,
          quoted_text: 'France will beat Morocco',
          status: 'confirmed',
          classifier_confidence: 1,
          parse: null,
          expires_at: null,
          created_at: target.created_at,
        }),
        getUser: async () => ({ id: 700, display_name: 'Alice', username: null }),
        getMarket: async () => ({ ...target, status: 'settled' }),
      },
      engine: {
        reduceMarket(state: MarketState) {
          return {
            state: { ...state, status: 'settled' as const },
            effects: [{
              kind: 'settle' as const,
              outcome: 'claim_won' as const,
              decidingSeq: EVENT.seq,
              evidenceSeqs: [EVENT.seq],
            }],
          };
        },
      },
      wager: {
        applySettlement: async () => { wagerSettlements += 1; },
      },
      env: { WEB_BASE_URL: 'https://calledit.example', SOLANA_NETWORK: 'devnet' },
      log: { info() {}, warn() {}, error() {}, child() { return this; } },
    } as unknown as Deps;
    const settler = new Settler(
      deps,
      { post(_chatId: number, text: string) { receipts.push(text); } } as never,
      async () => 'Settled.',
      {
        apply: async () => ({
          eligible: false,
          duplicate: false,
          marketId: target.id,
          groupId: GROUP_ID,
          reason: 'replay',
        }),
      } as never,
      null,
    );

    // When the replay settles
    await settler.onReplayEvent(GROUP_ID, EVENT, 0);

    // Then terminal state persists, while the wager ledger remains untouched
    expect(persisted).toEqual(['status', 'settlement']);
    expect(wagerSettlements).toBe(0);
    expect(receipts.join('\n')).toContain('Test round - no starter position or real funds moved.');
  });

  it('applies mainnet USDC replay settlement and renders its real payout line', async () => {
    const target = market({ currency: 'usdc' });
    const wagerSettlements: Array<{ marketId: string; requireFullyBacked: boolean | undefined }> = [];
    const receipts: string[] = [];
    const deps = {
      db: {
        openMarketsForFixture: async () => [target],
        positionsForMarket: async () => [],
        updateMarketStatus: async () => undefined,
        insertSettlement: async () => undefined,
        getClaim: async () => ({
          id: target.claim_id,
          group_id: GROUP_ID,
          claimer_user_id: 700,
          tg_message_id: 1,
          quoted_text: 'France will beat Morocco',
          status: 'confirmed',
          classifier_confidence: 1,
          parse: null,
          expires_at: null,
          created_at: target.created_at,
        }),
        getUser: async () => ({ id: 700, display_name: 'Alice', username: null }),
        getMarket: async () => ({ ...target, status: 'settled' }),
      },
      engine: {
        reduceMarket(state: MarketState) {
          return {
            state: { ...state, status: 'settled' as const },
            effects: [{
              kind: 'settle' as const,
              outcome: 'claim_won' as const,
              decidingSeq: EVENT.seq,
              evidenceSeqs: [EVENT.seq],
            }],
          };
        },
      },
      wager: {
        applySettlement: async (
          marketId: string,
          options?: { requireFullyBacked?: boolean },
        ) => {
          wagerSettlements.push({
            marketId,
            requireFullyBacked: options?.requireFullyBacked,
          });
        },
        settlementPayoutsLine: async () => 'Alice collects 2 USDC. (mainnet)',
      },
      env: { WEB_BASE_URL: 'https://calledit.example', SOLANA_NETWORK: 'mainnet-beta' },
      log: { info() {}, warn() {}, error() {}, child() { return this; } },
    } as unknown as Deps;
    const settler = new Settler(
      deps,
      { post(_chatId: number, text: string) { receipts.push(text); } } as never,
      async () => 'Settled.',
      {
        apply: async () => ({
          eligible: false,
          duplicate: false,
          marketId: target.id,
          groupId: GROUP_ID,
          reason: 'replay',
        }),
      } as never,
      null,
    );

    await settler.onReplayEvent(GROUP_ID, EVENT, 0);

    expect(wagerSettlements).toEqual([{ marketId: target.id, requireFullyBacked: true }]);
    expect(receipts.join('\n')).toContain('Alice collects 2 USDC. (mainnet)');
    expect(receipts.join('\n')).not.toContain('Test round');
  });
});
