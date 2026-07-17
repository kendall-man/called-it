import assert from 'node:assert/strict';
import test from 'node:test';
import { withFreshGroupPointsDb } from './group-points-db.js';
import { addPositions, applyGroupPoints, pointState, seedMarket } from './group-points-support.js';

export function registerGroupPointsScoringSuite(): void {
  test('group-points RPC scores distinct active users and excludes every non-participant state', async () => {
    // Given: one winner with duplicate taps, one loser, excluded pending/void taps, and an untapped caller.
    await withFreshGroupPointsDb(async (client) => {
      const settledAt = '2026-02-05T00:00:00.000Z';
      const fixture = await seedMarket(client, {
        groupId: -10_007,
        marketNumber: 10_007,
        callerUserId: 20_007,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        status: 'settled',
        settlement: { outcome: 'claim_won', settledAt },
      });
      await addPositions(client, fixture, { userId: 30_001, side: 'back', count: 2 });
      await addPositions(client, fixture, { userId: 30_002, side: 'doubt' });
      await addPositions(client, fixture, { userId: 30_003, side: 'back', state: 'pending' });
      await addPositions(client, fixture, { userId: 30_004, side: 'doubt', state: 'void' });

      // When: points are applied from persisted settlement and position rows.
      const result = await applyGroupPoints(client, fixture.marketId);

      // Then: each distinct active user gets exactly one result and projection.
      assert.deepEqual(result, {
        ok: true,
        eligible: true,
        duplicate: false,
        reason: null,
        group_id: fixture.groupId,
        scored_count: 2,
        winner_count: 1,
      });
      const settledAtMs = String(Date.parse(settledAt));
      assert.deepEqual(await pointState(client), {
        events: [
          { groupId: String(fixture.groupId), marketId: fixture.marketId, userId: '30001', side: 'back', result: 'won', pointsDelta: '10', scoringVersion: 1, settledAtMs },
          { groupId: String(fixture.groupId), marketId: fixture.marketId, userId: '30002', side: 'doubt', result: 'lost', pointsDelta: '0', scoringVersion: 1, settledAtMs },
        ],
        stats: [
          { groupId: String(fixture.groupId), userId: '30001', points: '10', wins: '1', losses: '0', currentStreak: '1', bestStreak: '1', updatedAtMs: settledAtMs },
          { groupId: String(fixture.groupId), userId: '30002', points: '0', wins: '0', losses: '1', currentStreak: '0', bestStreak: '0', updatedAtMs: settledAtMs },
        ],
        markers: [{
          marketId: fixture.marketId,
          groupId: String(fixture.groupId),
          scoringVersion: 1,
          settledAtMs,
        }],
      });
    });
  });

  test('group-points RPC rebuilds streaks by settlement time and market id regardless of apply order', async () => {
    // Given: four markets inserted in one group, including a tied settlement timestamp.
    await withFreshGroupPointsDb(async (client) => {
      const groupId = -11_000;
      const userId = 31_000;
      const cases = [
        { marketNumber: 11_001, outcome: 'claim_won' as const, settledAt: '2026-02-06T00:00:00.000Z' },
        { marketNumber: 11_002, outcome: 'claim_lost' as const, settledAt: '2026-02-07T00:00:00.000Z' },
        { marketNumber: 11_003, outcome: 'claim_won' as const, settledAt: '2026-02-07T00:00:00.000Z' },
        { marketNumber: 11_004, outcome: 'claim_won' as const, settledAt: '2026-02-08T00:00:00.000Z' },
      ];
      const fixtures = [];
      for (const item of cases) {
        const fixture = await seedMarket(client, {
          groupId,
          marketNumber: item.marketNumber,
          callerUserId: 21_000,
          pointsStartedAt: '2026-02-01T00:00:00.000Z',
          status: 'settled',
          settlement: { outcome: item.outcome, settledAt: item.settledAt },
        });
        await addPositions(client, fixture, { userId, side: 'back' });
        fixtures.push(fixture);
      }

      // When: the markets are applied in reverse and nonchronological order.
      for (const index of [3, 1, 2, 0]) {
        const fixture = fixtures[index];
        assert.ok(fixture);
        const result = await applyGroupPoints(client, fixture.marketId);
        assert.equal(result.ok, true);
      }

      // Then: claim_lost maps to doubt and the final projection follows (time, market id).
      const state = await pointState(client);
      assert.deepEqual(state.events.map((event) => ({
        marketId: event.marketId,
        side: event.side,
        result: event.result,
        pointsDelta: event.pointsDelta,
      })), [
        { marketId: fixtures[0]?.marketId, side: 'back', result: 'won', pointsDelta: '10' },
        { marketId: fixtures[1]?.marketId, side: 'back', result: 'lost', pointsDelta: '0' },
        { marketId: fixtures[2]?.marketId, side: 'back', result: 'won', pointsDelta: '10' },
        { marketId: fixtures[3]?.marketId, side: 'back', result: 'won', pointsDelta: '10' },
      ]);
      assert.deepEqual(state.stats, [{
        groupId: String(groupId),
        userId: String(userId),
        points: '30',
        wins: '3',
        losses: '1',
        currentStreak: '2',
        bestStreak: '2',
        updatedAtMs: String(Date.parse(cases[3]?.settledAt ?? '')),
      }]);
    });
  });

  test('group-points RPC keeps one user independent across two groups', async () => {
    // Given: the same participant backs terminal calls in two different groups.
    await withFreshGroupPointsDb(async (client) => {
      const userId = 32_000;
      const won = await seedMarket(client, {
        groupId: -12_001,
        marketNumber: 12_001,
        callerUserId: 22_001,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        status: 'settled',
        settlement: { outcome: 'claim_won', settledAt: '2026-02-09T00:00:00.000Z' },
      });
      const lost = await seedMarket(client, {
        groupId: -12_002,
        marketNumber: 12_002,
        callerUserId: 22_002,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        status: 'settled',
        settlement: { outcome: 'claim_lost', settledAt: '2026-02-09T00:00:00.000Z' },
      });
      await addPositions(client, won, { userId, side: 'back' });
      await addPositions(client, lost, { userId, side: 'back' });

      // When: both markets are applied.
      await applyGroupPoints(client, won.marketId);
      await applyGroupPoints(client, lost.marketId);

      // Then: group-scoped projections do not merge the shared user identity.
      const stats = (await pointState(client)).stats.map((row) => ({
        groupId: row.groupId,
        userId: row.userId,
        points: row.points,
        wins: row.wins,
        losses: row.losses,
        currentStreak: row.currentStreak,
        bestStreak: row.bestStreak,
      }));
      assert.deepEqual(stats, [
        { groupId: '-12002', userId: '32000', points: '0', wins: '0', losses: '1', currentStreak: '0', bestStreak: '0' },
        { groupId: '-12001', userId: '32000', points: '10', wins: '1', losses: '0', currentStreak: '1', bestStreak: '1' },
      ]);
    });
  });
}
