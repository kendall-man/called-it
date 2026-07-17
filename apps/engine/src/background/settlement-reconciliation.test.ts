import type { MatchEvent } from '@calledit/market-engine';
import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../ports.js';
import {
  GROUP_ONE_ID,
  GROUP_TWO_ID,
} from '../points/telegram-points-flow-fixtures.test-support.js';
import { createTelegramFlowRuntime } from '../points/telegram-points-flow-runtime.test-support.js';
import { createSettlementReconciler } from '../settle/settlement-reconciler.js';
import { createAllowlistedBackgroundDeps } from './allowlisted-db.js';

const DISALLOWED_GROUP_ID = -100_910_003;
const FIXTURE_ID = 5_101;

async function seedCandidate(input: {
  readonly runtime: ReturnType<typeof createTelegramFlowRuntime>;
  readonly groupId: number;
  readonly sequence: number;
}): Promise<MarketRow> {
  const market = await input.runtime.db.insertMarket({
    claim_id: `reconcile-claim-${input.sequence}`,
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
  await input.runtime.db.insertPosition({
    market_id: market.id,
    user_id: 91_001 + input.sequence,
    side: 'back',
    stake: 10_000_000,
    locked_multiplier: 2,
    locked_odds_message_id: null,
    locked_odds_ts: null,
    state: 'active',
    placed_at_ms: input.runtime.deps.now() - 60_000,
  });
  return market;
}

describe('allowlisted settlement reconciliation', () => {
  it('reconciles only the allowed persisted market from a terminal snapshot', async () => {
    // Given one allowed and two disallowed candidate markets with active positions
    const runtime = createTelegramFlowRuntime();
    runtime.deps.env.DEPLOYMENT_ENV = 'production';
    runtime.deps.env.BETA_ALLOWED_GROUP_IDS = [GROUP_ONE_ID];
    runtime.db.seedGroup({
      id: DISALLOWED_GROUP_ID,
      title: 'Legacy End',
      slug: 'legacy-end',
      web_enabled: true,
      chattiness: 'nudge',
      is_admin: true,
    });
    const markets = await Promise.all([
      seedCandidate({ runtime, groupId: GROUP_ONE_ID, sequence: 1 }),
      seedCandidate({ runtime, groupId: GROUP_TWO_ID, sequence: 2 }),
      seedCandidate({ runtime, groupId: DISALLOWED_GROUP_ID, sequence: 3 }),
    ]);
    const event: MatchEvent = {
      kind: 'phase_change',
      fixtureId: FIXTURE_ID,
      seq: 41,
      tsMs: runtime.deps.now() - 90_001,
      receivedAtMs: runtime.deps.now() - 90_001,
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
    runtime.deps.tx.fetchScoreEvents = async (fixtureId) =>
      fixtureId === FIXTURE_ID ? [event] : [];
    runtime.wager.applySettlement = runtime.wager.applySettlement.bind(runtime.wager);
    const backgroundDeps = createAllowlistedBackgroundDeps(runtime.deps);
    const reconciler = createSettlementReconciler(backgroundDeps, runtime.log);

    // When the production reconciliation tick runs
    await reconciler.tick();

    // Then only the allowed market and settlement are mutated and applied
    expect(runtime.db.persistedPointState(markets[0]?.id ?? '')).toMatchObject({
      marketStatus: 'settled',
      settlementPosted: false,
    });
    for (const market of markets.slice(1)) {
      expect(runtime.db.persistedPointState(market.id)).toMatchObject({
        marketStatus: 'open',
        settlementPosted: false,
      });
    }
    expect((await runtime.db.unpostedSettlements()).map((row) => row.market_id)).toEqual([
      markets[0]?.id,
    ]);
    expect(runtime.wager.appliedSettlements).toEqual([markets[0]?.id]);
    expect(runtime.transport.calls).toEqual([]);
    expect(runtime.log.events.filter((entry) => entry.event.includes('send_failed'))).toEqual([]);
  });
});
