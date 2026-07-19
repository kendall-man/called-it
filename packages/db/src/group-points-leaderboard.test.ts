import { describe, expect, it } from 'vitest';
import { queryDb, queryDbResponses, type QueryCall } from './group-points-test-support.js';

const leaderboardRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  group_id: -100_123,
  user_id: 7001,
  points: 20,
  wins: 2,
  losses: 1,
  current_streak: 1,
  best_streak: 2,
  user: { display_name: 'Alice', username: 'alice_calls' },
  ...overrides,
});

describe('group points leaderboard queries', () => {
  it('returns a bounded group-only leaderboard with stable ties and derived accuracy', async () => {
    // Given tied rows from the new per-group stats projection
    const calls: QueryCall[] = [];
    const db = queryDb(
      {
        data: [
          leaderboardRow(),
          leaderboardRow({
            user_id: 7002,
            current_streak: 0,
            best_streak: 1,
            user: { display_name: 'Bob', username: null },
          }),
        ],
        error: null,
      },
      calls,
    );

    // When the group's top ten is requested
    const board = await db.leaderboard(-100_123, 10);

    // Then the query and projection are narrow, bounded, and deterministic
    expect(calls).toEqual([
      { method: 'from', args: ['group_player_stats_from_events'] },
      {
        method: 'select',
        args: [
          'group_id,user_id,points,wins,losses,current_streak,best_streak,user',
        ],
      },
      { method: 'eq', args: ['group_id', -100_123] },
      { method: 'order', args: ['points', { ascending: false }] },
      { method: 'order', args: ['wins', { ascending: false }] },
      { method: 'order', args: ['losses', { ascending: true }] },
      { method: 'order', args: ['user_id', { ascending: true }] },
      { method: 'limit', args: [10] },
    ]);
    expect(board).toEqual([
      {
        group_id: -100_123,
        user_id: 7001,
        display_name: 'Alice',
        username: 'alice_calls',
        points: 20,
        wins: 2,
        losses: 1,
        accuracy: 2 / 3,
        current_streak: 1,
        best_streak: 2,
      },
      {
        group_id: -100_123,
        user_id: 7002,
        display_name: 'Bob',
        username: null,
        points: 20,
        wins: 2,
        losses: 1,
        accuracy: 2 / 3,
        current_streak: 0,
        best_streak: 1,
      },
    ]);
  });

  it('falls back to the cached leaderboard only when the event view is unavailable', async () => {
    const calls: QueryCall[] = [];
    const db = queryDbResponses([
      {
        data: null,
        error: { code: '42P01', message: 'relation does not exist' },
      },
      { data: [leaderboardRow()], error: null },
    ], calls);

    await expect(db.leaderboard(-100_123, 10)).resolves.toHaveLength(1);
    expect(calls.filter((call) => call.method === 'from')).toEqual([
      { method: 'from', args: ['group_player_stats_from_events'] },
      { method: 'from', args: ['group_player_stats'] },
    ]);
    expect(calls.filter((call) => call.method === 'select').at(-1)).toEqual({
      method: 'select',
      args: [
        'group_id,user_id,points,wins,losses,current_streak,best_streak,user:users!inner(display_name,username)',
      ],
    });
  });

  it('rejects stale rows that violate the stable rank order', async () => {
    // Given rows returned in the opposite order from the indexed contract
    const db = queryDb({
      data: [
        leaderboardRow({
          user_id: 7001,
          points: 10,
          wins: 1,
          losses: 0,
          best_streak: 1,
        }),
        leaderboardRow({
          user_id: 7002,
          losses: 0,
          current_streak: 2,
          user: { display_name: 'Bob', username: null },
        }),
      ],
      error: null,
    });

    // When the board is parsed
    const result = db.leaderboard(-100_123, 10);

    // Then stale ordering is rejected rather than displayed
    await expect(result).rejects.toThrow('database contract violation at <order>');
  });

  it('rejects limits outside one through one hundred before querying', async () => {
    // Given invalid lower, upper, fractional, and unsafe limits
    const calls: QueryCall[] = [];
    const db = queryDb({ data: [], error: null }, calls);

    // When each invalid bound is requested
    for (const limit of [0, 101, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(db.leaderboard(-100_123, limit)).rejects.toThrow(
        'database contract violation at limit',
      );
    }

    // Then no invalid read was attempted and the inclusive upper bound is forwarded
    expect(calls).toEqual([]);
    await expect(db.leaderboard(-100_123, 100)).resolves.toEqual([]);
    expect(calls.at(-1)).toEqual({ method: 'limit', args: [100] });
  });

  it('rejects unsafe group identifiers before querying', async () => {
    // Given an otherwise valid leaderboard request
    const calls: QueryCall[] = [];
    const db = queryDb({ data: [], error: null }, calls);

    // When an unsafe group identifier is requested
    const result = db.leaderboard(Number.NaN, 10);

    // Then the request fails before reaching the database
    await expect(result).rejects.toThrow('database contract violation at group_id');
    expect(calls).toEqual([]);
  });
});
