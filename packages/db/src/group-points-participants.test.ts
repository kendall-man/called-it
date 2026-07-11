import { describe, expect, it } from 'vitest';
import { MARKET_ID, queryDb, type QueryCall } from './group-points-test-support.js';

const participantRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  market_id: MARKET_ID,
  user_id: 7001,
  side: 'back',
  placed_at_ms: 1_720_000_000_001,
  market: { id: MARKET_ID, group_id: -100_123 },
  user: { display_name: 'Alice', username: 'alice_calls' },
  ...overrides,
});

describe('group point participant queries', () => {
  it('returns distinct participants in first-placement order without crossing groups', async () => {
    // Given active rows with one repeated user and side placement
    const calls: QueryCall[] = [];
    const db = queryDb(
      {
        data: [
          participantRow({
            user_id: 7002,
            side: 'doubt',
            user: { display_name: 'Bob', username: null },
          }),
          participantRow({ placed_at_ms: 1_720_000_000_002 }),
          participantRow({ placed_at_ms: 1_720_000_000_003 }),
        ],
        error: null,
      },
      calls,
    );

    // When participants are loaded for one market
    const participants = await db.positionParticipantsForMarket(MARKET_ID);

    // Then only active rows are read and repeated placements do not repeat labels
    expect(calls).toEqual([
      { method: 'from', args: ['positions'] },
      {
        method: 'select',
        args: [
          'market_id,user_id,side,placed_at_ms,market:markets!inner(id,group_id),user:users!inner(display_name,username)',
        ],
      },
      { method: 'eq', args: ['market_id', MARKET_ID] },
      { method: 'eq', args: ['state', 'active'] },
      { method: 'order', args: ['placed_at_ms', { ascending: true }] },
      { method: 'order', args: ['user_id', { ascending: true }] },
      { method: 'order', args: ['side', { ascending: true }] },
    ]);
    expect(participants).toEqual([
      {
        group_id: -100_123,
        market_id: MARKET_ID,
        user_id: 7002,
        side: 'doubt',
        display_name: 'Bob',
        username: null,
      },
      {
        group_id: -100_123,
        market_id: MARKET_ID,
        user_id: 7001,
        side: 'back',
        display_name: 'Alice',
        username: 'alice_calls',
      },
    ]);
  });

  it('rejects rows that make one market appear in multiple groups', async () => {
    // Given a cross-group-looking response for one requested market
    const db = queryDb({
      data: [
        participantRow({ placed_at_ms: 1 }),
        participantRow({
          user_id: 7002,
          side: 'doubt',
          placed_at_ms: 2,
          market: { id: MARKET_ID, group_id: -100_999 },
          user: { display_name: 'Mallory', username: null },
        }),
      ],
      error: null,
    });

    // When participants are parsed
    const result = db.positionParticipantsForMarket(MARKET_ID);

    // Then the facade fails closed at the group boundary
    await expect(result).rejects.toThrow('database contract violation at group_id');
  });

  it('rejects rows that violate first-placement order', async () => {
    // Given rows returned with descending placement timestamps
    const db = queryDb({
      data: [
        participantRow({ placed_at_ms: 2 }),
        participantRow({ user_id: 7002, placed_at_ms: 1 }),
      ],
      error: null,
    });

    // When participants are parsed
    const result = db.positionParticipantsForMarket(MARKET_ID);

    // Then stale ordering is rejected rather than normalized locally
    await expect(result).rejects.toThrow('database contract violation at <order>');
  });
});
