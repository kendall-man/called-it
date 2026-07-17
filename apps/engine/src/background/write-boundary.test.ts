import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../ports.js';
import {
  GROUP_ONE_ID,
  GROUP_TWO_ID,
} from '../points/telegram-points-flow-fixtures.test-support.js';
import { createTelegramFlowRuntime } from '../points/telegram-points-flow-runtime.test-support.js';
import { createAllowlistedBackgroundDb } from './allowlisted-db.js';

const DISALLOWED_GROUP_ID = -100_910_003;
const FIXTURE_ID = 5_101;

async function seedMarket(input: {
  readonly runtime: ReturnType<typeof createTelegramFlowRuntime>;
  readonly groupId: number;
  readonly sequence: number;
}): Promise<MarketRow> {
  return input.runtime.db.insertMarket({
    claim_id: `write-claim-${input.sequence}`,
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

describe('allowlisted background writes', () => {
  it('drops direct market and settlement writes for disallowed persisted markets', async () => {
    // Given one allowed and two disallowed persisted markets
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
      seedMarket({ runtime, groupId: GROUP_ONE_ID, sequence: 1 }),
      seedMarket({ runtime, groupId: GROUP_TWO_ID, sequence: 2 }),
      seedMarket({ runtime, groupId: DISALLOWED_GROUP_ID, sequence: 3 }),
    ]);
    const db = createAllowlistedBackgroundDb(runtime.db, runtime.deps.env);

    // When direct background market and settlement writes are attempted
    for (const market of markets) {
      await db.updateMarketStatus(market.id, 'settled');
      await db.insertSettlement({
        market_id: market.id,
        outcome: 'claim_won',
        deciding_seq: 31,
        evidence_seqs: [31],
        tier: 'oracle_resolved',
      });
      await db.markSettlementPosted(market.id);
    }

    // Then the allowed writes succeed and both disallowed markets remain untouched
    expect(runtime.db.persistedPointState(markets[0]?.id ?? '')).toMatchObject({
      marketStatus: 'settled',
      settlementPosted: true,
    });
    for (const market of markets.slice(1)) {
      expect(runtime.db.persistedPointState(market.id)).toMatchObject({
        marketStatus: 'open',
        settlementPosted: false,
      });
    }
    expect(runtime.transport.calls).toEqual([]);
    expect(runtime.log.events.filter((entry) => entry.event.includes('send_failed'))).toEqual([]);
  });
});
