import { describe, expect, it } from 'vitest';
import { TELEGRAM_MESSAGE_LIMIT } from '../points/presentation.js';
import { makeFakeDeps, type FakeWagerDb } from '../wager/fakes.js';
import { createStarterOnlyWagerModule } from '../wager/starter-only-module.js';
import { starterOnlyWagerDbFromFake } from '../wager/starter-fake.test-support.js';
import { buildStarterOnlyWagerDb } from '../wiring-wager-starter-db.js';
import { MARKET_ID, createSettlementHarness } from './group-points-settlement.test-support.js';

const BROKEN_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function seedHighParticipationPayout(db: FakeWagerDb): readonly number[] {
  db.seedMarketProbability(MARKET_ID, 0.5);
  const winnerIds = Array.from({ length: 100 }, (_, index) => 10_000 + index);
  for (const userId of [...winnerIds].reverse()) {
    db.users.set(
      userId,
      `\u0000\u202e\uD800Winner ${userId - 9_999} ${'🏆'.repeat(80)} @raw_${userId} id:${userId}\n`,
    );
    db.seedPosition({
      market_id: MARKET_ID, user_id: userId, side: 'back', stake: 1_000_000,
    });
  }
  db.seedPosition({
    market_id: MARKET_ID, user_id: 10_000, side: 'back', stake: 1_000_000,
  });
  for (let index = 0; index < 100; index += 1) {
    db.seedPosition({
      market_id: MARKET_ID,
      user_id: 20_000 + index,
      side: 'doubt',
      stake: index === 0 ? 2_000_000 : 1_000_000,
    });
  }
  return winnerIds;
}

describe('bounded payout receipt recovery', () => {
  it('retries 100 winners without duplicating points or posted state', async () => {
    // Given 100 winners, 100 losers, duplicate stakes, unsafe long names, and one failed send
    const { db: payoutDb, deps: payoutDeps } = makeFakeDeps();
    const winnerIds = seedHighParticipationPayout(payoutDb);
    const packageDb = starterOnlyWagerDbFromFake(payoutDb);
    const bulkQueries: number[][] = [];
    const harness = await createSettlementHarness({
      wager: (timeline) => createStarterOnlyWagerModule({
        runtimeMode: 'starter_only',
        db: buildStarterOnlyWagerDb({
          packageDb,
          engineDb: {
            positionsForMarket: (marketId) => payoutDb.positionsForMarket(marketId),
            setPositionStates: (ids, state) => payoutDb.setPositionStates(ids, state),
            async getUserNames(userIds) {
              bulkQueries.push([...userIds]);
              timeline.push('sol_payouts');
              return payoutDb.getUserNames(userIds);
            },
          },
        }),
        log: payoutDeps.log,
        starterGrantsEnabled: true,
        stakeAcceptanceEnabled: true,
      }),
    });
    const claim = await harness.deps.db.getClaim(harness.market.claim_id);
    if (claim === null) throw new TypeError('Settlement test claim is missing');
    Object.assign(harness.deps.db, {
      getClaim: async () => ({ ...claim, quoted_text: '🏆'.repeat(3_000) }),
      getUser: async (id: number) => ({
        id, display_name: '🏆'.repeat(3_000), username: null,
      }),
    });
    harness.telegram.failNext();

    // When the failed receipt is retried through the same Settler and Poster path
    await harness.settler.postReceipt(harness.market, 'claim_won');
    await harness.queue.idle();
    const afterFailure = {
      attempts: harness.telegram.attempts,
      sends: harness.telegram.texts.length,
      marks: harness.markedMarketIds.length,
      pointMarkers: harness.pointMarkerMarketIds.length,
      pointEvents: harness.pointEventUserIds.length,
      bulkQueries: bulkQueries.length,
    };
    await harness.settler.postReceipt(harness.market, 'claim_won');
    await harness.queue.idle();

    // Then projection reaches Poster twice, while durable points and posted state land once
    const receipt = harness.telegram.texts[0] ?? '';
    const payoutLine = receipt.split('\n').find((line) => line.startsWith('💠')) ?? '';
    expect(afterFailure).toEqual({
      attempts: 1, sends: 0, marks: 0, pointMarkers: 1, pointEvents: 2, bulkQueries: 1,
    });
    expect(bulkQueries).toEqual([winnerIds.slice(0, 5), winnerIds.slice(0, 5)]);
    expect(harness.pointApplyMarketIds).toEqual([MARKET_ID, MARKET_ID]);
    expect(harness.pointMarkerMarketIds).toEqual([MARKET_ID]);
    expect(harness.pointEventUserIds).toEqual([6001, 6002]);
    expect(harness.telegram.attempts).toBe(2);
    expect(harness.telegram.texts).toHaveLength(1);
    expect(harness.markedMarketIds).toEqual([MARKET_ID]);
    expect(receipt).toContain('and 95 more winners collect test SOL.');
    expect(payoutLine).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
    expect(payoutLine).not.toContain('@raw_');
    expect(payoutLine).not.toMatch(BROKEN_SURROGATE);
    expect(receipt.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(harness.timeline).toEqual([
      'points_apply', 'points_results', 'points_leaderboard', 'sol_payouts',
      'telegram_send_failed',
      'points_apply', 'points_results', 'points_leaderboard', 'sol_payouts',
      'telegram_send', 'mark_posted',
    ]);
  });
});
