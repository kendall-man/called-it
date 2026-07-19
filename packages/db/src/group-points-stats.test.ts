import { describe, expect, it } from 'vitest';
import type { PgResult } from './errors.js';
import { queryDb, queryDbResponses, type QueryCall } from './group-points-test-support.js';

describe('group player stats queries', () => {
  it('derives zero-safe accuracy from the group-only stats projection', async () => {
    // Given one stats row plus legacy fields that must not affect the projection
    const calls: QueryCall[] = [];
    const response: PgResult<unknown> = {
      data: {
        group_id: -100_123,
        user_id: 7001,
        points: 20,
        wins: 2,
        losses: 1,
        current_streak: 2,
        best_streak: 2,
        accuracy: 1,
        points_cached: 999_999,
      },
      error: null,
    };
    const db = queryDb(response, calls);

    // When personal stats are loaded inside that group
    const stats = await db.groupPlayerStats(-100_123, 7001);

    // Then only the new projection contributes to totals and accuracy
    expect(calls).toEqual([
      { method: 'from', args: ['group_player_stats_from_events'] },
      {
        method: 'select',
        args: ['group_id,user_id,points,wins,losses,current_streak,best_streak'],
      },
      { method: 'eq', args: ['group_id', -100_123] },
      { method: 'eq', args: ['user_id', 7001] },
      { method: 'maybeSingle', args: [] },
    ]);
    expect(stats).toEqual({
      group_id: -100_123,
      user_id: 7001,
      points: 20,
      wins: 2,
      losses: 1,
      accuracy: 2 / 3,
      current_streak: 2,
      best_streak: 2,
    });
    expect(stats).not.toHaveProperty('points_cached');
  });

  it('falls back to canonical source tables while the event view rolls out', async () => {
    const calls: QueryCall[] = [];
    const db = queryDbResponses([
      {
        data: null,
        error: { code: 'PGRST205', message: 'relation is not in the schema cache' },
      },
      {
        data: [{ id: -100_123, points_started_at: '2026-01-01T00:00:00.000Z' }],
        error: null,
      },
      {
        data: [],
        error: null,
      },
    ], calls);

    await expect(db.groupPlayerStats(-100_123, 7001)).resolves.toMatchObject({ points: 0, wins: 0 });
    expect(calls.filter((call) => call.method === 'from')).toEqual([
      { method: 'from', args: ['group_player_stats_from_events'] },
      { method: 'from', args: ['groups'] },
      { method: 'from', args: ['markets'] },
    ]);
  });

  it('returns read-only zero stats when the player has no scored calls', async () => {
    // Given no projection row for this user in this group
    const calls: QueryCall[] = [];
    const db = queryDb({ data: null, error: null }, calls);

    // When personal stats are requested
    const stats = await db.groupPlayerStats(-100_123, 7999);

    // Then zeros are returned without issuing any write
    expect(stats).toEqual({
      group_id: -100_123,
      user_id: 7999,
      points: 0,
      wins: 0,
      losses: 0,
      accuracy: 0,
      current_streak: 0,
      best_streak: 0,
    });
    expect(calls.every((call) => !['insert', 'upsert', 'update'].includes(call.method))).toBe(true);
  });

  it('rejects stats whose point total disagrees with the scoring version', async () => {
    // Given a row that would display more points than its wins can earn
    const db = queryDb({
      data: {
        group_id: -100_123,
        user_id: 7001,
        points: 999,
        wins: 2,
        losses: 1,
        current_streak: 1,
        best_streak: 2,
      },
      error: null,
    });

    // When stats are parsed
    const result = db.groupPlayerStats(-100_123, 7001);

    // Then misleading totals fail closed
    await expect(result).rejects.toThrow('database contract violation at points');
  });

  it('rejects unsafe group and user identifiers before issuing a query', async () => {
    // Given a read facade whose empty response could resemble zero stats
    const calls: QueryCall[] = [];
    const db = queryDb({ data: null, error: null }, calls);

    // When unsafe identifiers cross the facade boundary
    const unsafeGroup = db.groupPlayerStats(Number.MAX_SAFE_INTEGER + 1, 7001);
    const unsafeUser = db.groupPlayerStats(-100_123, 0);

    // Then both fail before a lossy identifier reaches the database
    await expect(unsafeGroup).rejects.toThrow('database contract violation at group_id');
    await expect(unsafeUser).rejects.toThrow('database contract violation at user_id');
    expect(calls).toEqual([]);
  });
});
