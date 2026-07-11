import { describe, expect, it } from 'vitest';
import type { PositionParticipant, PositionRow } from '../ports/rows.js';
import {
  CHAT_ID,
  MARKET_ID,
  PRESET_01,
  USER_A,
  makeStakeContext,
  makeStakeHarness,
  stakeAction,
  stakeMarket,
} from '../bot/callbacks.stake.test-support.js';
import { dispatchCallback } from '../bot/callbacks.js';
import { composeClaimCard } from './render.js';

const POSITIONS = [
  {
    id: 'pending-alice',
    market_id: MARKET_ID,
    user_id: 8_010,
    side: 'back',
    stake: 10_000_000,
    locked_multiplier: 2,
    state: 'pending',
    placed_at_ms: 1,
  },
  {
    id: 'active-cara',
    market_id: MARKET_ID,
    user_id: 8_003,
    side: 'back',
    stake: 20_000_000,
    locked_multiplier: 2,
    state: 'active',
    placed_at_ms: 2,
  },
  {
    id: 'active-bob-first',
    market_id: MARKET_ID,
    user_id: 8_002,
    side: 'doubt',
    stake: 20_000_000,
    locked_multiplier: 2,
    state: 'active',
    placed_at_ms: 3,
  },
  {
    id: 'active-bob-duplicate',
    market_id: MARKET_ID,
    user_id: 8_002,
    side: 'doubt',
    stake: 10_000_000,
    locked_multiplier: 2,
    state: 'active',
    placed_at_ms: 4,
  },
  {
    id: 'void-mallory',
    market_id: MARKET_ID,
    user_id: 8_004,
    side: 'doubt',
    stake: 40_000_000,
    locked_multiplier: 2,
    state: 'void',
    placed_at_ms: 5,
  },
] satisfies readonly PositionRow[];

const PARTICIPANTS: readonly PositionParticipant[] = [
  {
    group_id: CHAT_ID - 1,
    market_id: MARKET_ID,
    user_id: 8_010,
    side: 'back',
    display_name: 'Other Group Alice',
    username: null,
  },
  {
    group_id: CHAT_ID,
    market_id: MARKET_ID,
    user_id: 8_010,
    side: 'back',
    display_name: 'Alice',
    username: 'alice_calls',
  },
  {
    group_id: CHAT_ID,
    market_id: MARKET_ID,
    user_id: 8_003,
    side: 'back',
    display_name: 'Cara',
    username: null,
  },
  {
    group_id: CHAT_ID,
    market_id: MARKET_ID,
    user_id: 8_002,
    side: 'doubt',
    display_name: '\u0000 Bob \u202e',
    username: 'bad-name',
  },
  {
    group_id: CHAT_ID,
    market_id: MARKET_ID,
    user_id: 8_002,
    side: 'doubt',
    display_name: 'Wrong Bob',
    username: null,
  },
];

describe('composeClaimCard participant projection', () => {
  it('shows pending and active identities from the joined market projection', async () => {
    // Given persisted positions and a duplicated projection containing another group
    const market = stakeMarket({ card_tg_message_id: 900 });
    const harness = makeStakeHarness({ marketRow: market, refreshableCard: true });
    harness.wagerDb.positions.push(...POSITIONS);
    const projectionCalls: string[] = [];
    const userReads: number[] = [];
    harness.h.deps.db.positionParticipantsForMarket = async (marketId) => {
      projectionCalls.push(marketId);
      return PARTICIPANTS;
    };
    harness.h.deps.db.getUser = async (userId) => {
      userReads.push(userId);
      return { id: userId, display_name: 'Caller', username: null };
    };

    // When the active Telegram card is composed
    const card = await composeClaimCard(harness.h.deps, market);

    // Then names follow the persisted non-void sides without changing financial totals
    expect(projectionCalls).toEqual([MARKET_ID]);
    expect(userReads).toEqual([USER_A]);
    expect(card?.text).toContain(
      [
        '⚡ Backing it: 0.03 SOL (2 in)',
        '🛑 Against it: 0.03 SOL (2 in)',
        '🤝 Matched: 100%',
        'It happens: @alice_calls, Cara',
        'It does not: Bob, and 1 more',
        'Choices and results are visible in this group.',
      ].join('\n'),
    );
    expect(card?.text.split('Bob')).toHaveLength(2);
    expect(card?.text).not.toMatch(/Wrong Bob|Other Group Alice|\u0000|\u202e/u);
    expect(card?.text).toContain(`Receipt: https://web.test/r/${MARKET_ID}`);
    expect(card?.text).toContain('Test SOL is a devnet token with no monetary value.');
  });

  it('uses one bounded projection and no participant lookups for 100 pending positions', async () => {
    // Given 100 pending positions and a five-per-side joined identity projection
    const market = stakeMarket({ card_tg_message_id: 900 });
    const harness = makeStakeHarness({ marketRow: market, refreshableCard: true });
    const pending: PositionRow[] = Array.from({ length: 100 }, (_, index) => ({
      id: `pending-${index}`,
      market_id: MARKET_ID,
      user_id: 9_000 + index,
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
        })),
    );
    bounded.unshift({
      group_id: CHAT_ID - 1,
      market_id: MARKET_ID,
      user_id: 9_000,
      side: 'back',
      display_name: 'Other Group',
      username: null,
    });
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
    expect(card?.text).toContain('It happens: Back 1, Back 2, Back 3, Back 4, Back 5, and 45 more');
    expect(card?.text).toContain('It does not: Doubt 1, Doubt 2, Doubt 3, Doubt 4, Doubt 5, and 45 more');
    expect(card?.text).not.toMatch(/Other Group|Back 6|Doubt 6/);
  });

  it('edits one named card and posts nothing when three duplicate taps race', async () => {
    // Given one callback delivered three times against an editable active card
    const harness = makeStakeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
    });
    const edits: string[] = [];
    const posts: string[] = [];
    harness.h.poster.editCard = (_chatId, _marketId, _messageId, text) => edits.push(text);
    harness.h.poster.post = (_chatId, text) => posts.push(text);
    harness.h.deps.db.positionParticipantsForMarket = async (marketId) =>
      harness.wagerDb.positions
        .filter((position) => position.state !== 'void')
        .map((position) => ({
          group_id: CHAT_ID,
          market_id: marketId,
          user_id: position.user_id,
          side: position.side,
          display_name: 'Alice',
          username: 'alice_calls',
        }));
    const { ctx } = makeStakeContext(USER_A, 'three-tap-delivery');

    // When Telegram retries the same tap concurrently
    await Promise.all(
      Array.from({ length: 3 }, () =>
        dispatchCallback(harness.h, ctx, stakeAction('back', PRESET_01)),
      ),
    );

    // Then the existing refresh is the only group-visible output
    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(edits).toHaveLength(1);
    expect(posts).toEqual([]);
    expect(edits.join('\n')).toContain(
      [
        'It happens: @alice_calls',
        'It does not: No one yet',
        'Choices and results are visible in this group.',
      ].join('\n'),
    );
  });
});
