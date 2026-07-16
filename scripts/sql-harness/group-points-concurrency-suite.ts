import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { withFreshGroupPointsDb } from './group-points-db.js';
import {
  addPositions,
  pointState,
  poolApplyGroupPoints,
  seedMarket,
} from './group-points-support.js';

export function registerGroupPointsConcurrencySuite(): void {
  test('group-points RPC serializes twenty concurrent applications of the same market', async () => {
    // Given: one eligible market with a winner and loser, plus twenty independent DB connections.
    await withFreshGroupPointsDb(async (client, connectionString) => {
      const settledAt = '2026-02-12T00:00:00.000Z';
      const fixture = await seedMarket(client, {
        groupId: -15_000,
        marketNumber: 15_001,
        callerUserId: 25_000,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        status: 'settled',
        settlement: { outcome: 'claim_won', settledAt },
      });
      await addPositions(client, fixture, { userId: 35_001, side: 'back' });
      await addPositions(client, fixture, { userId: 35_002, side: 'doubt' });
      const pool = new Pool({ connectionString, max: 20 });
      try {
        // When: all twenty connections invoke the RPC for the same market at once.
        const results = await Promise.all(
          Array.from({ length: 20 }, () => poolApplyGroupPoints(pool, fixture.marketId)),
        );

        // Then: exactly one call applies and nineteen report the same durable duplicate state.
        assert.equal(results.filter((result) => result.ok && !result.duplicate).length, 1);
        assert.equal(results.filter((result) => result.ok && result.duplicate).length, 19);
        assert.equal(results.filter((result) => !result.ok).length, 0);
        const settledAtMs = String(Date.parse(settledAt));
        assert.deepEqual(await pointState(client), {
          events: [
            { groupId: String(fixture.groupId), marketId: fixture.marketId, userId: '35001', side: 'back', result: 'won', pointsDelta: '10', scoringVersion: 1, settledAtMs },
            { groupId: String(fixture.groupId), marketId: fixture.marketId, userId: '35002', side: 'doubt', result: 'lost', pointsDelta: '0', scoringVersion: 1, settledAtMs },
          ],
          stats: [
            { groupId: String(fixture.groupId), userId: '35001', points: '10', wins: '1', losses: '0', currentStreak: '1', bestStreak: '1', updatedAtMs: settledAtMs },
            { groupId: String(fixture.groupId), userId: '35002', points: '0', wins: '0', losses: '1', currentStreak: '0', bestStreak: '0', updatedAtMs: settledAtMs },
          ],
          markers: [{
            marketId: fixture.marketId,
            groupId: String(fixture.groupId),
            scoringVersion: 1,
            settledAtMs,
          }],
        });
      } finally {
        await pool.end();
      }
    });
  });

  test('group-points RPC serializes concurrent opposite outcomes in one group deterministically', async () => {
    // Given: two users on both sides of two different same-group markets with opposite outcomes.
    await withFreshGroupPointsDb(async (client, connectionString) => {
      const groupId = -16_000;
      const firstSettledAt = '2026-02-13T00:00:00.000Z';
      const secondSettledAt = '2026-02-14T00:00:00.000Z';
      const claimWon = await seedMarket(client, {
        groupId,
        marketNumber: 16_001,
        callerUserId: 26_000,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        status: 'settled',
        settlement: { outcome: 'claim_won', settledAt: firstSettledAt },
      });
      const claimLost = await seedMarket(client, {
        groupId,
        marketNumber: 16_002,
        callerUserId: 26_000,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        status: 'settled',
        settlement: { outcome: 'claim_lost', settledAt: secondSettledAt },
      });
      for (const fixture of [claimWon, claimLost]) {
        await addPositions(client, fixture, { userId: 36_001, side: 'back' });
        await addPositions(client, fixture, { userId: 36_002, side: 'doubt' });
      }
      const pool = new Pool({ connectionString, max: 2 });
      try {
        // When: the distinct markets are scored concurrently through separate connections.
        const results = await Promise.all([
          poolApplyGroupPoints(pool, claimWon.marketId),
          poolApplyGroupPoints(pool, claimLost.marketId),
        ]);

        // Then: both apply once and projections follow settlement order, not lock acquisition order.
        assert.deepEqual(results, [
          { ok: true, eligible: true, duplicate: false, reason: null, group_id: groupId, scored_count: 2, winner_count: 1 },
          { ok: true, eligible: true, duplicate: false, reason: null, group_id: groupId, scored_count: 2, winner_count: 1 },
        ]);
        const firstSettledAtMs = String(Date.parse(firstSettledAt));
        const secondSettledAtMs = String(Date.parse(secondSettledAt));
        assert.deepEqual(await pointState(client), {
          events: [
            { groupId: String(groupId), marketId: claimWon.marketId, userId: '36001', side: 'back', result: 'won', pointsDelta: '10', scoringVersion: 1, settledAtMs: firstSettledAtMs },
            { groupId: String(groupId), marketId: claimWon.marketId, userId: '36002', side: 'doubt', result: 'lost', pointsDelta: '0', scoringVersion: 1, settledAtMs: firstSettledAtMs },
            { groupId: String(groupId), marketId: claimLost.marketId, userId: '36001', side: 'back', result: 'lost', pointsDelta: '0', scoringVersion: 1, settledAtMs: secondSettledAtMs },
            { groupId: String(groupId), marketId: claimLost.marketId, userId: '36002', side: 'doubt', result: 'won', pointsDelta: '10', scoringVersion: 1, settledAtMs: secondSettledAtMs },
          ],
          stats: [
            { groupId: String(groupId), userId: '36001', points: '10', wins: '1', losses: '1', currentStreak: '0', bestStreak: '1', updatedAtMs: secondSettledAtMs },
            { groupId: String(groupId), userId: '36002', points: '10', wins: '1', losses: '1', currentStreak: '1', bestStreak: '1', updatedAtMs: secondSettledAtMs },
          ],
          markers: [
            { marketId: claimWon.marketId, groupId: String(groupId), scoringVersion: 1, settledAtMs: firstSettledAtMs },
            { marketId: claimLost.marketId, groupId: String(groupId), scoringVersion: 1, settledAtMs: secondSettledAtMs },
          ],
        });
      } finally {
        await pool.end();
      }
    });
  });
}
