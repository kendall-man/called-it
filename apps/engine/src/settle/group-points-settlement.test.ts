import { describe, expect, it } from 'vitest';
import { GroupPointsApplicationError } from '../points/service.js';
import { MARKET_ID, createSettlementHarness } from './group-points-settlement.test-support.js';
import {
  FINAL_EVENT,
  createOneSidedScenario,
  testWager,
} from './group-points-settlement-recovery.test-support.js';

describe('group points settlement receipt recovery', () => {
  it('marks the settlement only after the queued receipt is sent', async () => {
    // Given a receipt whose Telegram send is paused inside the real send queue
    const harness = await createSettlementHarness();
    const releaseSend = harness.telegram.pauseNext();

    // When the existing receipt path queues the message
    await harness.settler.postReceipt(harness.market, 'claim_won');

    // Then persistence remains unmarked until Telegram confirms the send
    expect(harness.markedMarketIds).toEqual([]);
    releaseSend();
    await harness.queue.idle();
    expect(harness.telegram.texts).toHaveLength(1);
    expect(harness.telegram.texts[0]).toContain('RECEIPT');
    expect(harness.markedMarketIds).toEqual([MARKET_ID]);
  });

  it('applies points before sending a named receipt and marking it posted', async () => {
    // Given an eligible settled market with one winner, one miss, and a top five projection
    const harness = await createSettlementHarness();

    // When the real Settler prepares and drains the receipt through Poster and SendQueue
    await harness.settler.postReceipt(harness.market, 'claim_won');
    await harness.queue.idle();

    // Then point persistence and reads precede delivery, which alone precedes marking
    expect(harness.timeline).toEqual([
      'points_apply', 'points_results', 'points_leaderboard',
      'telegram_send', 'mark_posted',
    ]);
    expect(harness.telegram.texts[0]).toContain('Winners (+10 points): @alice_calls');
    expect(harness.telegram.texts[0]).toContain('Misses (+0 points): Bob');
    expect(harness.telegram.texts[0]).toContain('Group leaderboard');
    expect(harness.markedMarketIds).toEqual([MARKET_ID]);
  });

  it('settles a terminal event with test SOL and points exactly once', async () => {
    // Given an open market wired through the real Settler, Poster, and SendQueue seams
    const harness = await createSettlementHarness({
      market: { status: 'open' },
      wager: testWager,
    });

    // When the terminal event is delivered twice and the queue drains
    await harness.settler.onEvent(FINAL_EVENT);
    await harness.settler.tick(FINAL_EVENT.receivedAtMs + 120_000);
    await harness.settler.onEvent(FINAL_EVENT);
    await harness.queue.idle();

    // Then financial settlement precedes one points marker and one posted receipt
    expect(harness.timeline).toEqual([
      'wager_apply', 'points_apply', 'points_results', 'points_leaderboard',
      'sol_payouts', 'telegram_send', 'mark_posted',
    ]);
    expect(harness.settlementOutcomes).toEqual(['claim_won']);
    expect(harness.pointMarkerMarketIds).toEqual([MARKET_ID]);
    expect(harness.pointEventUserIds).toEqual([6001, 6002]);
    expect(harness.telegram.texts).toHaveLength(1);
    const receipt = harness.telegram.texts[0] ?? '';
    expect(receipt.indexOf('💠 Test SOL outcome finalized.'))
      .toBeLessThan(receipt.indexOf('Points'));
    expect(harness.markedMarketIds).toEqual([MARKET_ID]);
  });

  it('does not enqueue or mark when points fail before the atomic apply', async () => {
    // Given the database is unavailable before point application can commit
    const harness = await createSettlementHarness({
      pointsDb: {
        applyGroupPoints: async () => {
          throw new Error('private database detail');
        },
      },
    });

    // When the unposted receipt is attempted
    const action = harness.settler.postReceipt(harness.market, 'claim_won');

    // Then the retryable failure happens before Telegram and posted_at remain untouched
    await expect(action).rejects.toBeInstanceOf(GroupPointsApplicationError);
    await harness.queue.idle();
    expect(harness.telegram.attempts).toBe(0);
    expect(harness.markedMarketIds).toEqual([]);
    expect(JSON.stringify(harness.logs)).not.toContain('private database detail');
  });

  it('recovers after atomic points commit before receipt send', async () => {
    // Given the atomic points RPC commits but its first result read is interrupted
    const harness = await createSettlementHarness({ pointResultFailures: 1 });

    // When the unposted receipt is retried through the same real delivery seams
    await expect(harness.settler.postReceipt(harness.market, 'claim_won'))
      .rejects.toBeInstanceOf(GroupPointsApplicationError);
    const beforeRetry = {
      sends: harness.telegram.attempts,
      marks: harness.markedMarketIds.length,
      markers: harness.pointMarkerMarketIds.length,
      events: harness.pointEventUserIds.length,
    };
    await harness.settler.postReceipt(harness.market, 'claim_won');
    await harness.queue.idle();

    // Then before-post observables recover to one eventual send without duplicate scores
    expect(beforeRetry).toEqual({ sends: 0, marks: 0, markers: 1, events: 2 });
    expect(harness.pointApplyMarketIds).toEqual([MARKET_ID, MARKET_ID]);
    expect(harness.pointMarkerMarketIds).toEqual([MARKET_ID]);
    expect(harness.pointEventUserIds).toEqual([6001, 6002]);
    expect(harness.telegram.texts).toHaveLength(1);
    expect(harness.markedMarketIds).toEqual([MARKET_ID]);
  });

  it('retries an unmarked receipt after Telegram send failure', async () => {
    // Given the first queued Telegram request will fail
    const harness = await createSettlementHarness();
    harness.telegram.failNext();

    // When the receipt attempt drains, then the unposted path retries it
    await harness.settler.postReceipt(harness.market, 'claim_won');
    await harness.queue.idle();
    const afterFailure = {
      attempts: harness.telegram.attempts,
      sends: harness.telegram.texts.length,
      marks: harness.markedMarketIds.length,
    };
    await harness.settler.postReceipt(harness.market, 'claim_won');
    await harness.queue.idle();

    // Then only a confirmed Telegram send marks posted and points remain exact once
    expect(afterFailure).toEqual({ attempts: 1, sends: 0, marks: 0 });
    expect(harness.telegram.attempts).toBe(2);
    expect(harness.telegram.texts).toHaveLength(1);
    expect(harness.markedMarketIds).toEqual([MARKET_ID]);
    expect(harness.pointMarkerMarketIds).toEqual([MARKET_ID]);
    expect(harness.pointEventUserIds).toEqual([6001, 6002]);
  });

  it('retries after Telegram succeeds but mark-posted fails', async () => {
    // Given the first onSent persistence callback is interrupted
    let markAttempts = 0;
    const harness = await createSettlementHarness({
      markPosted: async () => {
        markAttempts += 1;
        if (markAttempts === 1) throw new Error('mark unavailable');
      },
    });

    // When one send reaches Telegram and the unposted path retries
    await harness.settler.postReceipt(harness.market, 'claim_won');
    await harness.queue.idle();
    expect(harness.telegram.texts).toHaveLength(1);
    expect(harness.markedMarketIds).toEqual([]);
    await harness.settler.postReceipt(harness.market, 'claim_won');
    await harness.queue.idle();

    // Then recovery may resend but records one successful posted mark and one score set
    expect(harness.telegram.texts).toHaveLength(2);
    expect(markAttempts).toBe(2);
    expect(harness.markedMarketIds).toEqual([MARKET_ID]);
    expect(harness.pointMarkerMarketIds).toEqual([MARKET_ID]);
    expect(harness.pointEventUserIds).toEqual([6001, 6002]);
  });

  it.each(['void', 'claim_won'] as const)(
    'renders an eligible empty %s outcome without participant score lines',
    async (outcome) => {
      // Given the atomic marker contains no point events or leaderboard rows
      const harness = await createSettlementHarness({
        pointsDb: {
          applyGroupPoints: async () => ({
            ok: true, eligible: true, duplicate: false, reason: null,
            group_id: -100_600, scored_count: 0, winner_count: 0,
          }),
          pointResultsForMarket: async () => [],
          leaderboard: async () => [],
        },
      });

      // When the void or participant-free receipt is delivered
      await harness.settler.postReceipt(harness.market, outcome);
      await harness.queue.idle();

      // Then void hides points entirely; a scored empty call shows only the empty board
      const receipt = harness.telegram.texts[0] ?? '';
      expect(receipt).not.toMatch(/Winners \(|Misses \(/);
      expect(receipt.includes('Group leaderboard')).toBe(outcome !== 'void');
      expect(harness.markedMarketIds).toEqual([MARKET_ID]);
    },
  );

  it('posts a historical unposted settlement without identity reads or points', async () => {
    // Given an old settlement predates group points activation
    let identityReads = 0;
    const harness = await createSettlementHarness({
      pointsDb: {
        applyGroupPoints: async () => ({
          ok: true, eligible: false, duplicate: false, reason: 'pre_activation',
          group_id: -100_600, scored_count: 0, winner_count: 0,
        }),
        pointResultsForMarket: async () => { identityReads += 1; return []; },
        leaderboard: async () => { identityReads += 1; return []; },
      },
    });

    // When the existing unposted-sweeper path retries the historical receipt
    await harness.settler.postReceipt(harness.market, 'claim_won');
    await harness.queue.idle();

    // Then it delivers and marks without exposing a current group board
    expect(identityReads).toBe(0);
    expect(harness.telegram.texts[0]).not.toMatch(/Points|Group leaderboard/);
    expect(harness.markedMarketIds).toEqual([MARKET_ID]);
  });

  it('keeps a one-sided test SOL refund separate from the correct participant points', async () => {
    // Given one active backer whose wager and points stores record settlement state
    const scenario = createOneSidedScenario();
    const harness = await createSettlementHarness({
      market: { status: 'open' },
      wager: scenario.wager,
      pointsDb: scenario.pointsDb,
    });

    // When the terminal event settles and its debounce expires
    await harness.settler.onEvent(FINAL_EVENT);
    await harness.settler.tick(FINAL_EVENT.receivedAtMs + 120_000);
    await harness.queue.idle();

    // Then exact persisted finance/points state drives separate bounded copy
    expect(scenario.state.refundApplications).toBe(1);
    expect(scenario.state.refunds).toEqual([
      { marketId: MARKET_ID, userId: 6001, lamports: 10_000_000 },
    ]);
    expect(scenario.state.pointApplications).toBe(1);
    expect(scenario.state.pointEvents).toEqual([{
      group_id: -100_600, market_id: MARKET_ID, user_id: 6001, side: 'back',
      result: 'won', points_delta: 10, display_name: 'Alice', username: 'alice_calls',
    }]);
    expect(scenario.state.stats).toEqual([{
      group_id: -100_600, user_id: 6001, points: 10, wins: 1, losses: 0,
      accuracy: 1, current_streak: 1, best_streak: 1,
      display_name: 'Alice', username: 'alice_calls',
    }]);
    const receipt = harness.telegram.texts[0] ?? '';
    expect(receipt).toContain('💠 1 unmatched test SOL stake returned.');
    expect(receipt).toContain('Winners (+10 points): @alice_calls');
    expect(receipt.indexOf('💠')).toBeLessThan(receipt.indexOf('Points'));
    expect(receipt).not.toContain('Misses (+0 points)');
    expect(receipt.length).toBeLessThanOrEqual(4_096);
  });

});
