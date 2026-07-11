import { Api } from 'grammy';
import type { Logger, LogFields } from '../log.js';
import { loadEnv } from '../env.js';
import { createDeps } from '../wiring.js';
import { createPoster } from '../bot/poster.js';
import { renderFallback, type Say } from '../bot/copy.js';
import { SendQueue } from '../bot/sendQueue.js';
import type { ClaimRow, Deps, EngineDb, MarketRow, PositionRow } from '../ports.js';
import type { MatchEvent } from '@calledit/market-engine';
import type { WagerModule } from '../wager/module.js';
import { createGroupPointsService } from '../points/service.js';
import { Settler } from './settler.js';
import { SettlementReconciler } from './settlement-reconciler.js';
import {
  SETTLEMENT_TEST_ENV,
  TelegramTransport,
} from './group-points-settlement-telegram.test-support.js';

export const GROUP_ID = -100_600;
export const MARKET_ID = '60000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-07-12T12:00:00.000Z');

type CapturedLog = {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: LogFields | undefined;
};

function marketRow(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: MARKET_ID,
    claim_id: 'claim-600',
    group_id: GROUP_ID,
    fixture_id: 600,
    spec: {
      claimType: 'match_winner',
      fixtureId: 600,
      entityRef: { kind: 'team', participant: 1, name: 'Alpha FC' },
      comparator: 'gte',
      threshold: 1,
      period: 'FT_90',
      trustTier: 'oracle_resolved',
    },
    status: 'settled',
    is_replay: false,
    price_provenance: 'market',
    quote_probability: 0.5,
    quote_multiplier: 2,
    odds_message_id: 'odds-600',
    odds_ts: NOW - 1_000,
    card_tg_message_id: null,
    created_at: new Date(NOW - 60_000).toISOString(),
    currency: 'sol',
    ...overrides,
  };
}

function claimRow(): ClaimRow {
  return {
    id: 'claim-600',
    group_id: GROUP_ID,
    claimer_user_id: 6001,
    tg_message_id: 60,
    quoted_text: 'Alpha FC will win',
    status: 'confirmed',
    classifier_confidence: 1,
    parse: null,
    expires_at: null,
    created_at: new Date(NOW - 60_000).toISOString(),
  };
}

export interface SettlementHarness {
  readonly deps: Deps;
  readonly settler: Settler;
  readonly market: MarketRow;
  readonly queue: SendQueue;
  readonly telegram: TelegramTransport;
  readonly markedMarketIds: readonly string[];
  readonly logs: readonly CapturedLog[];
  readonly timeline: readonly string[];
  readonly pointApplyMarketIds: readonly string[];
  readonly pointMarkerMarketIds: readonly string[];
  readonly pointEventUserIds: readonly number[];
  readonly settlementOutcomes: readonly string[];
  reconcile(event: MatchEvent): Promise<void>;
}

type PointsDb = Pick<
  EngineDb,
  'applyGroupPoints' | 'pointResultsForMarket' | 'leaderboard'
>;

export interface SettlementHarnessOptions {
  readonly pointsDb?: Partial<PointsDb>;
  readonly market?: Partial<MarketRow>;
  readonly positions?: readonly PositionRow[];
  readonly wager?: (timeline: string[]) => WagerModule;
  readonly markPosted?: (marketId: string) => Promise<void>;
  readonly pointResultFailures?: number;
}

export async function createSettlementHarness(
  options: SettlementHarnessOptions = {},
): Promise<SettlementHarness> {
  const logs: CapturedLog[] = [];
  const timeline: string[] = [];
  const log: Logger = {
    info: (event, fields) => logs.push({ level: 'info', event, fields }),
    warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
    error: (event, fields) => logs.push({ level: 'error', event, fields }),
    child: () => log,
  };
  const telegram = new TelegramTransport(timeline, GROUP_ID, NOW);
  const queue = new SendQueue({
    ratePerMinute: 100,
    collapseMs: 0,
    now: () => NOW,
    onError: (error) => log.error('send_failed', { error: String(error) }),
  });
  const poster = createPoster(
    new Api(SETTLEMENT_TEST_ENV.TELEGRAM_BOT_TOKEN, { fetch: telegram.fetch }),
    queue,
    log,
  );
  const deps = await createDeps(loadEnv(SETTLEMENT_TEST_ENV), log);
  const market = marketRow(options.market);
  const claim = claimRow();
  const markedMarketIds: string[] = [];
  const pointApplyMarketIds: string[] = [];
  const pointMarkerMarketIds: string[] = [];
  const pointEventUserIds: number[] = [];
  const settlementOutcomes: string[] = [];
  const feedSequences = new Set<number>();
  let pointResultFailures = options.pointResultFailures ?? 0;
  deps.wager = options.wager?.(timeline) ?? null;
  Object.assign(deps.db, {
    getClaim: async (id: string) => (id === claim.id ? claim : null),
    getUser: async (id: number) => ({ id, display_name: 'Alex', username: 'alex_calls' }),
    getMarket: async (id: string) => (id === market.id ? market : null),
    insertFeedEvent: async (event: { readonly seq: number }) => {
      if (feedSequences.has(event.seq)) return { inserted: false };
      feedSequences.add(event.seq);
      return { inserted: true };
    },
    updateFixtureFromEvent: async () => undefined,
    liveFixtures: async () => [{
      fixture_id: 600, p1_name: 'Alpha FC', p2_name: 'Beta FC',
      kickoff_at: new Date(NOW - 7_200_000).toISOString(), phase: 'H2', minute: 90,
      last_seq: 60, score: {}, coverage_unreliable: false,
    }],
    openMarketsForFixture: async () => [market],
    positionsForMarket: async () => [...(options.positions ?? [])],
    updateMarketStatus: async () => undefined,
    insertSettlement: async (settlement: { readonly outcome: string }) => {
      settlementOutcomes.push(settlement.outcome);
    },
    applyGroupPoints: async (marketId: string) => {
      timeline.push('points_apply');
      pointApplyMarketIds.push(marketId);
      const duplicate = pointMarkerMarketIds.includes(marketId);
      if (!duplicate) {
        pointMarkerMarketIds.push(marketId);
        pointEventUserIds.push(6001, 6002);
      }
      return {
        ok: true,
        eligible: true,
        duplicate,
        reason: null,
        group_id: GROUP_ID,
        scored_count: 2,
        winner_count: 1,
      };
    },
    pointResultsForMarket: async () => {
      timeline.push('points_results');
      if (pointResultFailures > 0) {
        pointResultFailures -= 1;
        throw new Error('private point projection failure');
      }
      return [
        {
          group_id: GROUP_ID, market_id: MARKET_ID, user_id: 6001, side: 'back',
          result: 'won', points_delta: 10, display_name: 'Alice', username: 'alice_calls',
        },
        {
          group_id: GROUP_ID, market_id: MARKET_ID, user_id: 6002, side: 'doubt',
          result: 'lost', points_delta: 0, display_name: 'Bob', username: null,
        },
      ];
    },
    leaderboard: async () => {
      timeline.push('points_leaderboard');
      return [
        {
          group_id: GROUP_ID, user_id: 6001, display_name: 'Alice', username: 'alice_calls',
          points: 20, wins: 2, losses: 0, accuracy: 1, current_streak: 2, best_streak: 2,
        },
        {
          group_id: GROUP_ID, user_id: 6002, display_name: 'Bob', username: null,
          points: 0, wins: 0, losses: 1, accuracy: 0, current_streak: 0, best_streak: 0,
        },
      ];
    },
    markSettlementPosted: async (marketId: string) => {
      await options.markPosted?.(marketId);
      timeline.push('mark_posted');
      markedMarketIds.push(marketId);
    },
    ...options.pointsDb,
  });
  const say: Say = async (key, vars = {}) => renderFallback(key, vars);
  const points = createGroupPointsService({ db: deps.db, log });
  const reconcile = async (event: MatchEvent): Promise<void> => {
    const reconciler = new SettlementReconciler({
      db: deps.db,
      fetchScoreEvents: async () => [event],
      reduceMarket: deps.engine.reduceMarket,
      checkDebounce: deps.engine.checkDebounce,
      applySettlement: deps.wager?.applySettlement ?? null,
      log,
      now: () => event.receivedAtMs + 120_000,
      lookaheadMs: 900_000,
    });
    await reconciler.tick();
  };
  return {
    deps,
    settler: new Settler(deps, poster, say, points, null),
    market,
    queue,
    telegram,
    markedMarketIds,
    logs,
    timeline,
    pointApplyMarketIds,
    pointMarkerMarketIds,
    pointEventUserIds,
    settlementOutcomes,
    reconcile,
  };
}
