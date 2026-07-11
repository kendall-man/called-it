import { describe, expect, it } from 'vitest';
import { MARKET_ID, createSettlementHarness } from './group-points-settlement.test-support.js';
import {
  FINAL_EVENT,
  installPersistedSweeper,
  testWager,
} from './group-points-settlement-recovery.test-support.js';

describe('group points persisted settlement recovery', () => {
  it('queries and converges an unposted reconciler settlement without in-flight duplicates', async () => {
    // Given reconciliation persists an unposted terminal row and applies the wager outcome
    const harness = await createSettlementHarness({
      market: { status: 'open' }, wager: testWager,
      positions: [{
        id: 'position-6001', market_id: MARKET_ID, user_id: 6001, side: 'back',
        stake: 10_000_000, locked_multiplier: 2, state: 'active',
        placed_at_ms: FINAL_EVENT.receivedAtMs - 1_000,
      }],
    });
    const persisted = installPersistedSweeper(harness);
    await harness.reconcile(FINAL_EVENT);
    expect(persisted.persisted()?.posted_at).toBeNull();
    expect(harness.telegram.attempts).toBe(0);

    // When one real sweep queues a blocked send and another sweep sees it in flight
    const releaseSend = harness.telegram.pauseNext();
    await persisted.sweep();
    await persisted.sweep();
    expect(persisted.queryCount()).toBe(2);
    expect(harness.pointApplyMarketIds).toEqual([MARKET_ID]);
    expect(harness.telegram.attempts).toBe(1);
    expect(persisted.postedCount()).toBe(0);

    // Then delivery marks the row and the next real query returns no retry work
    releaseSend();
    await harness.queue.idle();
    await persisted.sweep();
    expect(persisted.queryCount()).toBe(3);
    expect(persisted.postedCount()).toBe(1);
    expect(persisted.persisted()?.posted_at).not.toBeNull();
    expect(harness.telegram.texts).toHaveLength(1);
    expect(harness.pointMarkerMarketIds).toEqual([MARKET_ID]);
    expect(harness.pointEventUserIds).toEqual([6001, 6002]);
  });
});
