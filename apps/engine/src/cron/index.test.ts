import { TUNABLES } from '@calledit/market-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarketRow } from '../ports.js';
import { ENGINE } from '../engineConstants.js';
import {
  GROUP_ONE_ID,
  GROUP_TWO_ID,
} from '../points/telegram-points-flow-fixtures.test-support.js';
import { createTelegramFlowRuntime } from '../points/telegram-points-flow-runtime.test-support.js';
import { startCrons, sweepUnpostedSettlements } from './index.js';

const DISALLOWED_GROUP_ID = -100_910_003;
const FIXTURE_ID = 5_101;

async function seedUnpostedSettlement(input: {
  readonly runtime: ReturnType<typeof createTelegramFlowRuntime>;
  readonly groupId: number;
  readonly sequence: number;
}): Promise<MarketRow> {
  const market = await input.runtime.db.insertMarket({
    claim_id: `claim-${input.sequence}`,
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
    status: 'settled',
    is_replay: true,
    price_provenance: 'market',
    quote_probability: 0.5,
    quote_multiplier: 2,
    odds_message_id: null,
    odds_ts: null,
    currency: 'sol',
  });
  await input.runtime.db.insertSettlement({
    market_id: market.id,
    outcome: 'claim_won',
    deciding_seq: 12,
    evidence_seqs: [12],
    tier: 'oracle_resolved',
  });
  return market;
}

describe('production background allowlist', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reposts only the allowed persisted settlement', async () => {
    // Given one allowed and two disallowed persisted markets with unposted settlements
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
      seedUnpostedSettlement({ runtime, groupId: GROUP_ONE_ID, sequence: 1 }),
      seedUnpostedSettlement({ runtime, groupId: GROUP_TWO_ID, sequence: 2 }),
      seedUnpostedSettlement({ runtime, groupId: DISALLOWED_GROUP_ID, sequence: 3 }),
    ]);
    runtime.db.applyGroupPoints = async (marketId) => {
      const market = await runtime.db.getMarket(marketId);
      if (market === null) return { ok: false, code: 'market_not_found' };
      return {
        ok: true,
        eligible: false,
        duplicate: false,
        reason: 'replay',
        group_id: market.group_id,
        scored_count: 0,
        winner_count: 0,
      };
    };

    // When the unposted-settlement background sweep runs
    await sweepUnpostedSettlements(runtime.deps, runtime.settler, new Map());
    await runtime.queue.idle();

    // Then only the allowed receipt is sent and marked, with no send failure
    const receiptCalls = runtime.transport.calls.filter(
      (call) => call.method === 'sendMessage' && call.text?.includes('CALLED IT.') === true,
    );
    expect(receiptCalls.map((call) => call.chatId)).toEqual([GROUP_ONE_ID]);
    expect(runtime.db.trace.filter((entry) => entry.startsWith('receipt:posted:'))).toEqual([
      `receipt:posted:${markets[0]?.id}`,
    ]);
    expect(runtime.log.events.filter((event) => event.event.includes('send_failed'))).toEqual([]);
  });

  it('isolates a failed historical settlement so later receipts still recover', async () => {
    const runtime = createTelegramFlowRuntime();
    runtime.deps.env.DEPLOYMENT_ENV = 'production';
    runtime.deps.env.BETA_ALLOWED_GROUP_IDS = [GROUP_ONE_ID];
    const [poison, recoverable] = await Promise.all([
      seedUnpostedSettlement({ runtime, groupId: GROUP_ONE_ID, sequence: 11 }),
      seedUnpostedSettlement({ runtime, groupId: GROUP_ONE_ID, sequence: 12 }),
    ]);
    runtime.db.applyGroupPoints = async (marketId) => {
      const market = await runtime.db.getMarket(marketId);
      if (market === null) return { ok: false, code: 'market_not_found' };
      return {
        ok: true,
        eligible: false,
        duplicate: false,
        reason: 'replay',
        group_id: market.group_id,
        scored_count: 0,
        winner_count: 0,
      };
    };
    const originalPostReceipt = runtime.settler.postReceipt.bind(runtime.settler);
    vi.spyOn(runtime.settler, 'postReceipt').mockImplementation(async (market, outcome) => {
      if (market.id === poison?.id) throw new TypeError('malformed historical row');
      await originalPostReceipt(market, outcome);
    });

    await sweepUnpostedSettlements(runtime.deps, runtime.settler, new Map());
    await runtime.queue.idle();

    expect(runtime.db.trace).toContain(`receipt:posted:${recoverable?.id}`);
    expect(runtime.log.events).toContainEqual(expect.objectContaining({
      event: 'settlement_sweep_market_failed',
      fields: { marketId: poison?.id },
    }));
  });

  it('posts the morning slate only to the allowed persisted group', async () => {
    // Given three nudge-mode admin groups and one production-allowed group
    vi.useFakeTimers();
    const runtime = createTelegramFlowRuntime();
    runtime.deps.env.DEPLOYMENT_ENV = 'production';
    runtime.deps.env.BETA_ALLOWED_GROUP_IDS = [GROUP_ONE_ID];
    runtime.deps.now = () => Date.UTC(
      2026,
      6,
      12,
      TUNABLES.MORNING_SLATE_HOUR_UTC,
    );
    await runtime.db.setGroupChattiness(GROUP_ONE_ID, 'nudge');
    await runtime.db.setGroupChattiness(GROUP_TWO_ID, 'nudge');
    runtime.db.seedGroup({
      id: DISALLOWED_GROUP_ID,
      title: 'Legacy End',
      slug: 'legacy-end',
      web_enabled: true,
      chattiness: 'nudge',
      is_admin: true,
    });
    const crons = startCrons({
      deps: runtime.deps,
      poster: runtime.h.poster,
      say: runtime.h.say,
      settler: runtime.settler,
      supervisor: runtime.h.supervisor,
      settlementReconciler: { tick: async () => undefined },
    });

    // When the minute-grade cron reaches the morning-slate branch
    await vi.advanceTimersByTimeAsync(ENGINE.MINUTE_TICK_MS);
    await runtime.queue.idle();
    crons.stop();

    // Then Telegram receives a slate only for the exact allowlisted group
    expect(runtime.transport.calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => call.chatId)).toEqual([GROUP_ONE_ID]);
    expect(runtime.log.events.filter((event) => event.event.includes('send_failed'))).toEqual([]);
  });
});
