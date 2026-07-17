import type { MatchEvent } from '@calledit/market-engine';
import { describe, expect, it } from 'vitest';
import { IngestSupervisor } from '../ingest/supervisor.js';
import type { MarketRow } from '../ports.js';
import { createGroupPointsService } from '../points/service.js';
import {
  GROUP_ONE_ID,
  GROUP_TWO_ID,
} from '../points/telegram-points-flow-fixtures.test-support.js';
import { createTelegramFlowRuntime } from '../points/telegram-points-flow-runtime.test-support.js';
import { Settler } from '../settle/settler.js';
import {
  createAllowlistedBackgroundDb,
  createAllowlistedBackgroundDeps,
} from './allowlisted-db.js';

const DISALLOWED_GROUP_ID = -100_910_003;
const FIXTURE_ID = 5_101;

function seedLegacyGroup(runtime: ReturnType<typeof createTelegramFlowRuntime>): void {
  runtime.db.seedGroup({
    id: DISALLOWED_GROUP_ID,
    title: 'Legacy End',
    slug: 'legacy-end',
    web_enabled: true,
    chattiness: 'nudge',
    is_admin: true,
  });
}

async function seedOpenMarket(input: {
  readonly runtime: ReturnType<typeof createTelegramFlowRuntime>;
  readonly groupId: number;
  readonly sequence: number;
}): Promise<MarketRow> {
  return input.runtime.db.insertMarket({
    claim_id: `live-claim-${input.sequence}`,
    group_id: input.groupId,
    fixture_id: FIXTURE_ID,
    spec: {
      claimType: 'match_winner',
      fixtureId: FIXTURE_ID,
      entityRef: { kind: 'team', name: 'Atlas FC', participant: 1 },
      comparator: 'gte',
      threshold: 1,
      period: 'FT_90',
      trustTier: 'oracle_resolved',
    },
    status: 'open',
    is_replay: false,
    price_provenance: 'market',
    quote_probability: 0.5,
    quote_multiplier: 2,
    odds_message_id: null,
    odds_ts: null,
    currency: 'sol',
  });
}

describe('allowlisted background database', () => {
  it('scopes deployed overdue-claim expiry to the exact allowed group ids', async () => {
    // Given a production database projection with one allowed group
    const runtime = createTelegramFlowRuntime();
    runtime.deps.env.DEPLOYMENT_ENV = 'staging';
    runtime.deps.env.BETA_ALLOWED_GROUP_IDS = [GROUP_ONE_ID];
    const filters: Array<readonly number[] | undefined> = [];
    runtime.deps.db.expireOverdueClaims = async (
      _nowIso: string,
      allowedGroupIds?: readonly number[],
    ) => {
      filters.push(allowedGroupIds);
      return [];
    };
    const db = createAllowlistedBackgroundDb(runtime.deps.db, runtime.deps.env);

    // When the background expiry write runs
    await db.expireOverdueClaims('2026-07-12T12:00:00.000Z');

    // Then the write receives the exact production allowlist
    expect(filters).toEqual([[GROUP_ONE_ID]]);
  });

  it('leaves overdue-claim expiry unscoped in development', async () => {
    // Given development with a configured beta list
    const runtime = createTelegramFlowRuntime();
    runtime.deps.env.DEPLOYMENT_ENV = 'development';
    runtime.deps.env.BETA_ALLOWED_GROUP_IDS = [GROUP_ONE_ID];
    const filters: Array<readonly number[] | undefined> = [];
    runtime.deps.db.expireOverdueClaims = async (_nowIso, allowedGroupIds) => {
      filters.push(allowedGroupIds);
      return [];
    };
    const db = createAllowlistedBackgroundDb(runtime.deps.db, runtime.deps.env);

    // When development claim expiry runs
    await db.expireOverdueClaims('2026-07-12T12:00:00.000Z');

    // Then the original all-groups database behavior is preserved
    expect(filters).toEqual([undefined]);
  });

  it('projects one allowed group from persisted legacy product rows', async () => {
    // Given one allowed and two disallowed groups, markets, and settlements
    const runtime = createTelegramFlowRuntime();
    runtime.deps.env.DEPLOYMENT_ENV = 'production';
    runtime.deps.env.BETA_ALLOWED_GROUP_IDS = [GROUP_ONE_ID];
    seedLegacyGroup(runtime);
    const markets = await Promise.all([
      seedOpenMarket({ runtime, groupId: GROUP_ONE_ID, sequence: 11 }),
      seedOpenMarket({ runtime, groupId: GROUP_TWO_ID, sequence: 12 }),
      seedOpenMarket({ runtime, groupId: DISALLOWED_GROUP_ID, sequence: 13 }),
    ]);
    await Promise.all(markets.map((market) => runtime.db.insertSettlement({
      market_id: market.id,
      outcome: 'claim_won',
      deciding_seq: 21,
      evidence_seqs: [21],
      tier: 'oracle_resolved',
    })));
    const db = createAllowlistedBackgroundDb(runtime.db, runtime.deps.env);

    // When product background rows are discovered through the projection
    const groups = await db.listGroups();
    const fixtureMarkets = await db.openMarketsForFixture(FIXTURE_ID);
    const disallowedGroupMarkets = await db.openMarketsForGroup(GROUP_TWO_ID);
    const disallowedMarket = await db.getMarket(markets[1]?.id ?? '');
    const settlements = await db.unpostedSettlements();

    // Then only rows owned by the exact allowed group are visible
    expect(groups.map((group) => group.id)).toEqual([GROUP_ONE_ID]);
    expect(fixtureMarkets.map((market) => market.id)).toEqual([markets[0]?.id]);
    expect(disallowedGroupMarkets).toEqual([]);
    expect(disallowedMarket).toBeNull();
    expect(settlements.map((settlement) => settlement.market_id)).toEqual([markets[0]?.id]);
  });

  it('preserves all-groups background discovery in development', async () => {
    // Given development with a non-empty beta list and three persisted groups
    const runtime = createTelegramFlowRuntime();
    runtime.deps.env.DEPLOYMENT_ENV = 'development';
    runtime.deps.env.BETA_ALLOWED_GROUP_IDS = [GROUP_ONE_ID];
    seedLegacyGroup(runtime);
    const markets = await Promise.all([
      seedOpenMarket({ runtime, groupId: GROUP_ONE_ID, sequence: 21 }),
      seedOpenMarket({ runtime, groupId: GROUP_TWO_ID, sequence: 22 }),
      seedOpenMarket({ runtime, groupId: DISALLOWED_GROUP_ID, sequence: 23 }),
    ]);
    const db = createAllowlistedBackgroundDb(runtime.db, runtime.deps.env);

    // When development background discovery runs
    const groups = await db.listGroups();
    const fixtureMarkets = await db.openMarketsForFixture(FIXTURE_ID);
    const legacyMarket = await db.getMarket(markets[2]?.id ?? '');

    // Then the beta list does not narrow existing development behavior
    expect(groups.map((group) => group.id)).toEqual([
      GROUP_ONE_ID,
      GROUP_TWO_ID,
      DISALLOWED_GROUP_ID,
    ]);
    expect(fixtureMarkets.map((market) => market.id)).toEqual(markets.map((market) => market.id));
    expect(legacyMarket?.id).toBe(markets[2]?.id);
  });

  it('lets live ingest affect only persisted markets in allowed groups', async () => {
    // Given one allowed and two disallowed open markets on the same live fixture
    const runtime = createTelegramFlowRuntime();
    runtime.deps.env.DEPLOYMENT_ENV = 'production';
    runtime.deps.env.BETA_ALLOWED_GROUP_IDS = [GROUP_ONE_ID];
    seedLegacyGroup(runtime);
    const markets = await Promise.all([
      seedOpenMarket({ runtime, groupId: GROUP_ONE_ID, sequence: 1 }),
      seedOpenMarket({ runtime, groupId: GROUP_TWO_ID, sequence: 2 }),
      seedOpenMarket({ runtime, groupId: DISALLOWED_GROUP_ID, sequence: 3 }),
    ]);
    runtime.db.applyGroupPoints = async (marketId) => {
      const market = await runtime.db.getMarket(marketId);
      if (market === null) return { ok: false, code: 'market_not_found' };
      return {
        ok: true,
        eligible: false,
        duplicate: false,
        reason: 'pre_activation',
        group_id: market.group_id,
        scored_count: 0,
        winner_count: 0,
      };
    };
    const handlers = new Map<number, (event: MatchEvent) => Promise<void>>();
    runtime.deps.tx.createLiveSource = (fixtureId) => ({
      start: (onEvent) => { handlers.set(fixtureId, onEvent); },
      stop: () => undefined,
    });
    const backgroundDeps = createAllowlistedBackgroundDeps(runtime.deps);
    const points = createGroupPointsService({ db: backgroundDeps.db, log: runtime.log });
    const settler = new Settler(
      backgroundDeps,
      runtime.h.poster,
      runtime.h.say,
      points,
      null,
    );
    const supervisor = new IngestSupervisor(backgroundDeps, settler);
    await supervisor.refresh();
    const handleEvent = handlers.get(FIXTURE_ID);
    if (handleEvent === undefined) throw new TypeError('live fixture source was not started');
    const event: MatchEvent = {
      kind: 'phase_change',
      fixtureId: FIXTURE_ID,
      seq: 30,
      tsMs: runtime.deps.now(),
      receivedAtMs: runtime.deps.now(),
      confirmed: true,
      phase: 'ABD',
      minute: null,
      score: {
        p1: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
        p2: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
        p1Goals90: 1,
        p2Goals90: 0,
      },
    };

    // When the live source emits the terminal event
    await handleEvent(event);
    await runtime.queue.idle();
    supervisor.stopAll();

    // Then only the allowed market is written, paid, posted, and marked
    expect(runtime.db.persistedPointState(markets[0]?.id ?? '')).toMatchObject({
      marketStatus: 'voided',
      settlementPosted: true,
    });
    for (const market of markets.slice(1)) {
      expect(runtime.db.persistedPointState(market.id)).toMatchObject({
        marketStatus: 'open',
        pointsApplied: false,
        settlementPosted: false,
      });
    }
    expect(runtime.wager.appliedSettlements).toEqual([markets[0]?.id]);
    expect(runtime.transport.calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => call.chatId)).toEqual([GROUP_ONE_ID]);
    expect(runtime.log.events.filter((entry) => entry.event.includes('send_failed'))).toEqual([]);
  });
});
