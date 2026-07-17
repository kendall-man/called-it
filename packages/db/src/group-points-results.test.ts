import { describe, expect, it } from 'vitest';
import type { PgResult } from './errors.js';
import {
  MARKET_ID,
  queryDbResponses,
  type QueryCall,
} from './group-points-test-support.js';

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
  it('uses bounded joined outcome queries without legacy or public reads', async () => {
    // Given one winner and one miss returned by separate outcome projections
    const calls: QueryCall[] = [];
    const wonResponse: PgResult<unknown> = {
      data: [pointResultRow()],
      error: null,
    };
    const lostResponse: PgResult<unknown> = {
      data: [
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
    const db = queryDbResponses([wonResponse, lostResponse], calls);

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
      { method: 'eq', args: ['result', 'won'] },
      { method: 'order', args: ['points_delta', { ascending: false }] },
      { method: 'order', args: ['user_id', { ascending: true }] },
      { method: 'limit', args: [10] },
      { method: 'from', args: ['group_point_events'] },
      {
        method: 'select',
        args: [
          'group_id,market_id,user_id,side,result,points_delta,user:users!inner(display_name,username)',
        ],
      },
      { method: 'eq', args: ['market_id', MARKET_ID] },
      { method: 'eq', args: ['result', 'lost'] },
      { method: 'order', args: ['points_delta', { ascending: false }] },
      { method: 'order', args: ['user_id', { ascending: true }] },
      { method: 'limit', args: [10] },
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

  it('rejects a result partition larger than its database limit', async () => {
    // Given a malicious lost-result response with eleven rows despite limit ten
    const oversizedLostRows = Array.from({ length: 11 }, (_, index) =>
      pointResultRow({
        user_id: 8001 + index,
        side: 'doubt',
        result: 'lost',
        points_delta: 0,
      }),
    );
    const db = queryDbResponses([
      { data: [], error: null },
      { data: oversizedLostRows, error: null },
    ]);

    // When point results cross the facade boundary
    const result = db.pointResultsForMarket(MARKET_ID);

    // Then the facade distrusts the oversized PostgREST response
    await expect(result).rejects.toThrow('database contract violation at <rows>');
  });

  it('reserves ten result rows for each outcome', async () => {
    // Given both outcome partitions filled to their independent limits
    const wonRows = Array.from({ length: 10 }, (_, index) =>
      pointResultRow({ user_id: 7001 + index }),
    );
    const lostRows = Array.from({ length: 10 }, (_, index) =>
      pointResultRow({
        user_id: 8001 + index,
        side: 'doubt',
        result: 'lost',
        points_delta: 0,
      }),
    );
    const db = queryDbResponses([
      { data: wonRows, error: null },
      { data: lostRows, error: null },
    ]);

    // When the bounded receipt projection is loaded
    const results = await db.pointResultsForMarket(MARKET_ID);

    // Then neither outcome consumes the other's quota and total rows stay bounded
    expect(results).toHaveLength(20);
    expect(results.filter((result) => result.result === 'won')).toHaveLength(10);
    expect(results.filter((result) => result.result === 'lost')).toHaveLength(10);
  });

  it('rejects duplicate users that contradict the event primary key', async () => {
    // Given two result rows for the same market and user
    const repeated = pointResultRow();
    const db = queryDbResponses([
      { data: [repeated, repeated], error: null },
      { data: [], error: null },
    ]);

    // When market results are parsed
    const result = db.pointResultsForMarket(MARKET_ID);

    // Then duplicate receipt labels fail closed
    await expect(result).rejects.toThrow('database contract violation at user_id');
  });

  it('rejects rows that violate the stable result order', async () => {
    // Given equal-scoring rows returned with descending user identifiers
    const db = queryDbResponses([
      {
        data: [pointResultRow({ user_id: 7002 }), pointResultRow({ user_id: 7001 })],
        error: null,
      },
      { data: [], error: null },
    ]);

    // When market results are parsed
    const result = db.pointResultsForMarket(MARKET_ID);

    // Then stale ordering is rejected rather than displayed
    await expect(result).rejects.toThrow('database contract violation at <order>');
  });

  it('rejects rows that make one market appear in multiple groups', async () => {
    // Given outcome partitions that disagree about the market's group
    const db = queryDbResponses([
      { data: [pointResultRow()], error: null },
      {
        data: [
          pointResultRow({
            group_id: -100_999,
            user_id: 7002,
            side: 'doubt',
            result: 'lost',
            points_delta: 0,
          }),
        ],
        error: null,
      },
    ]);

    // When market results are parsed
    const result = db.pointResultsForMarket(MARKET_ID);

    // Then cross-group data is rejected at the facade boundary
    await expect(result).rejects.toThrow('database contract violation at group_id');
  });
});
