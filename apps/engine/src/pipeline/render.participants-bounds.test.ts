import { describe, expect, it } from 'vitest';
import type { PositionParticipant, PositionRow } from '../ports/rows.js';
import {
  CHAT_ID,
  MARKET_ID,
  USER_A,
  makeStakeHarness,
  stakeMarket,
} from '../bot/callbacks.stake.test-support.js';
import { composeClaimCard } from './render.js';

describe('composeClaimCard participant projection bounds', () => {
  it('uses distinct overflow totals for 100 pending financial positions', async () => {
    // Given 100 positions from seven distinct participants on each side.
    const market = stakeMarket({ card_tg_message_id: 900 });
    const harness = makeStakeHarness({ marketRow: market, refreshableCard: true });
    const pending: PositionRow[] = Array.from({ length: 100 }, (_, index) => ({
      id: `pending-${index}`,
      market_id: MARKET_ID,
      user_id:
        index % 2 === 0
          ? 9_000 + ((index / 2) % 7)
          : 9_100 + (((index - 1) / 2) % 7),
      side: index % 2 === 0 ? 'back' : 'doubt',
      stake: 10_000_000,
      locked_multiplier: 2,
      state: 'pending',
      placed_at_ms: index,
    }));
    harness.wagerDb.positions.push(...pending);
    const bounded = pending
      .filter((position) => position.side === 'back')
      .slice(0, 5)
      .map((position, index): PositionParticipant => ({
        group_id: CHAT_ID,
        market_id: MARKET_ID,
        user_id: position.user_id,
        side: position.side,
        display_name: `Back ${index + 1}`,
        username: null,
        participant_count: 7,
      }));
    bounded.push(
      ...pending
        .filter((position) => position.side === 'doubt')
        .slice(0, 5)
        .map((position, index): PositionParticipant => ({
          group_id: CHAT_ID,
          market_id: MARKET_ID,
          user_id: position.user_id,
          side: position.side,
          display_name: `Doubt ${index + 1}`,
          username: null,
          participant_count: 7,
        })),
    );
    const projectionCalls: string[] = [], userReads: number[] = [];
    harness.h.deps.db.positionParticipantsForMarket = async (marketId) => {
      projectionCalls.push(marketId);
      return bounded;
    };
    harness.h.deps.db.getUser = async (userId) => {
      userReads.push(userId);
      return { id: userId, display_name: `User ${userId}`, username: null };
    };

    // When the card is composed
    const card = await composeClaimCard(harness.h.deps, market);

    // Then only the caller is hydrated and the bounded, group-local labels reach the card
    expect(projectionCalls).toEqual([MARKET_ID]);
    expect(userReads).toEqual([USER_A]);
    expect(card?.text).toContain(
      'Brazil win it: Back 1, Back 2, Back 3, Back 4, Back 5, and 2 more',
    );
    expect(card?.text).toContain(
      "They don't: Doubt 1, Doubt 2, Doubt 3, Doubt 4, Doubt 5, and 2 more",
    );
    expect(card?.text).not.toMatch(/Back 6|Doubt 6/);
  });
});
