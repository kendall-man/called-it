import { TUNABLES } from '@calledit/market-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarketRow } from '../ports.js';
import { ENGINE } from '../engineConstants.js';
import {
  GROUP_ONE_ID,
  GROUP_TWO_ID,
} from '../points/telegram-points-flow-fixtures.test-support.js';
import { createTelegramFlowRuntime } from '../points/telegram-points-flow-runtime.test-support.js';
import { createAllowlistedBackgroundDeps } from '../background/allowlisted-db.js';
import { startCrons, syncFixtures } from './index.js';

const DISALLOWED_GROUP_ID = -100_910_003;
const FIXTURE_ID = 5_101;

async function seedAbandonedMarket(input: {
  readonly runtime: ReturnType<typeof createTelegramFlowRuntime>;
  readonly groupId: number;
  readonly sequence: number;
}): Promise<MarketRow> {
  const claim = await input.runtime.db.insertClaim({
    group_id: input.groupId,
    claimer_user_id: 91_000,
    tg_message_id: 600 + input.sequence,
    quoted_text: 'Atlas FC will win',
    status: 'confirmed',
    classifier_confidence: 1,
    expires_at: null,
  });
  const market = await input.runtime.db.insertMarket({
    claim_id: claim.id,
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
  await input.runtime.db.setMarketCardMessage(market.id, 700 + input.sequence);
  const persisted = await input.runtime.db.getMarket(market.id);
  if (persisted === null) throw new TypeError('Seeded abandoned market disappeared');
  return persisted;
}

describe('cron product background boundary', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('voids only the allowed abandoned market after kickoff', async () => {
    // Given one allowed and two disallowed zero-position markets after kickoff
    vi.useFakeTimers();
    const runtime = createTelegramFlowRuntime();
    runtime.deps.env.DEPLOYMENT_ENV = 'production';
    runtime.deps.env.BETA_ALLOWED_GROUP_IDS = [GROUP_ONE_ID];
    runtime.deps.now = () => Date.UTC(
      2026,
      6,
      12,
      (TUNABLES.MORNING_SLATE_HOUR_UTC + 1) % 24,
    );
    runtime.db.seedGroup({
      id: DISALLOWED_GROUP_ID,
      title: 'Legacy End',
      slug: 'legacy-end',
      web_enabled: true,
      chattiness: 'nudge',
      is_admin: true,
    });
    runtime.db.seedFixture({
      fixture_id: FIXTURE_ID,
      p1_name: 'Atlas FC',
      p2_name: 'Beacon FC',
      kickoff_at: new Date(runtime.deps.now() - 60_000).toISOString(),
      phase: 'H1',
      minute: 1,
      last_seq: 1,
      score: {},
      coverage_unreliable: false,
    });
    const markets = await Promise.all([
      seedAbandonedMarket({ runtime, groupId: GROUP_ONE_ID, sequence: 1 }),
      seedAbandonedMarket({ runtime, groupId: GROUP_TWO_ID, sequence: 2 }),
      seedAbandonedMarket({ runtime, groupId: DISALLOWED_GROUP_ID, sequence: 3 }),
    ]);
    const crons = startCrons({
      deps: runtime.deps,
      poster: runtime.h.poster,
      say: runtime.h.say,
      settler: runtime.settler,
      supervisor: runtime.h.supervisor,
      settlementReconciler: { tick: async () => undefined },
    });

    // When the minute-grade abandoned-market sweep runs
    await vi.advanceTimersByTimeAsync(ENGINE.MINUTE_TICK_MS);
    await runtime.queue.idle();
    crons.stop();

    // Then only the allowed market is voided and receives a settlement write
    expect(runtime.db.persistedPointState(markets[0]?.id ?? '')).toMatchObject({
      marketStatus: 'voided',
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
    const terminalEdits = runtime.transport.calls.filter(
      (call) => call.method === 'editMessageText',
    );
    expect(terminalEdits).toHaveLength(1);
    expect(terminalEdits[0]).toMatchObject({
      chatId: GROUP_ONE_ID,
      messageId: 701,
    });
    expect(terminalEdits[0]?.text).toContain('Call off');
    expect(runtime.log.events.filter((entry) => entry.event.includes('send_failed'))).toEqual([]);
  });

  it('keeps global fixture metadata sync enabled in production', async () => {
    // Given a production allowlist and a fixture with no allowlisted product rows
    const runtime = createTelegramFlowRuntime();
    runtime.deps.env.DEPLOYMENT_ENV = 'production';
    runtime.deps.env.BETA_ALLOWED_GROUP_IDS = [GROUP_ONE_ID];
    runtime.deps.tx.fetchFixtures = async () => [{
      fixture_id: 99_001,
      competition_id: 99,
      p1_id: 1,
      p1_name: 'Metadata FC',
      p2_id: 2,
      p2_name: 'Snapshot United',
      kickoff_at: '2026-07-13T12:00:00.000Z',
    }];
    const backgroundDeps = createAllowlistedBackgroundDeps(runtime.deps);

    // When the global fixture snapshot sync runs
    await syncFixtures(backgroundDeps);

    // Then the metadata row is still upserted and reported
    await expect(runtime.db.getFixture(99_001)).resolves.toMatchObject({
      fixture_id: 99_001,
      p1_name: 'Metadata FC',
      p2_name: 'Snapshot United',
    });
    expect(runtime.log.events.find((entry) => entry.event === 'fixtures_synced')?.fields)
      .toEqual({ count: 1 });
  });
});
