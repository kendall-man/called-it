import { describe, expect, it } from 'vitest';
import type { PgResult } from './errors.js';
import { MARKET_ID, queryDb, type QueryCall } from './group-points-test-support.js';

const pointResultRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  group_id: -100_123,
  market_id: MARKET_ID,
  user_id: 7001,
  side: 'back',
  result: 'won',
  points_delta: 10,
  user: { display_name: 'Alice', username: 'alice_calls' },
  ...overrides,
});

describe('group point result queries', () => {
  it('returns point results with labels from a market-scoped projection', async () => {
    // Given two persisted point events and only their bounded user labels
    const calls: QueryCall[] = [];
    const response: PgResult<unknown> = {
      data: [
        pointResultRow(),
        pointResultRow({
          user_id: 7002,
          side: 'doubt',
          result: 'lost',
          points_delta: 0,
          user: { display_name: 'Bob', username: null },
        }),
      ],
      error: null,
    };
    const db = queryDb(response, calls);

    // When results are loaded for one market
    const results = await db.pointResultsForMarket(MARKET_ID);

    // Then no wallet or unrestricted user fields can enter the projection
    expect(calls).toEqual([
      { method: 'from', args: ['group_point_events'] },
      {
        method: 'select',
        args: [
          'group_id,market_id,user_id,side,result,points_delta,user:users!inner(display_name,username)',
        ],
      },
      { method: 'eq', args: ['market_id', MARKET_ID] },
      { method: 'order', args: ['points_delta', { ascending: false }] },
      { method: 'order', args: ['user_id', { ascending: true }] },
    ]);
    expect(results).toEqual([
      {
        group_id: -100_123,
        market_id: MARKET_ID,
        user_id: 7001,
        side: 'back',
        result: 'won',
        points_delta: 10,
        display_name: 'Alice',
        username: 'alice_calls',
      },
      {
        group_id: -100_123,
        market_id: MARKET_ID,
        user_id: 7002,
        side: 'doubt',
        result: 'lost',
        points_delta: 0,
        display_name: 'Bob',
        username: null,
      },
    ]);
  });

  it('rejects duplicate users that contradict the event primary key', async () => {
    // Given two result rows for the same market and user
    const repeated = pointResultRow();
    const db = queryDb({ data: [repeated, repeated], error: null });

    // When market results are parsed
    const result = db.pointResultsForMarket(MARKET_ID);

    // Then duplicate receipt labels fail closed
    await expect(result).rejects.toThrow('database contract violation at user_id');
  });

  it('rejects rows that violate the stable result order', async () => {
    // Given equal-scoring rows returned with descending user identifiers
    const db = queryDb({
      data: [pointResultRow({ user_id: 7002 }), pointResultRow({ user_id: 7001 })],
      error: null,
    });

    // When market results are parsed
    const result = db.pointResultsForMarket(MARKET_ID);

    // Then stale ordering is rejected rather than displayed
    await expect(result).rejects.toThrow('database contract violation at <order>');
  });

  it('rejects rows that make one market appear in multiple groups', async () => {
    // Given one market response containing rows from two groups
    const db = queryDb({
      data: [pointResultRow(), pointResultRow({ group_id: -100_999, user_id: 7002 })],
      error: null,
    });

    // When market results are parsed
    const result = db.pointResultsForMarket(MARKET_ID);

    // Then cross-group data is rejected at the facade boundary
    await expect(result).rejects.toThrow('database contract violation at group_id');
  });
});
