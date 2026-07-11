import assert from 'node:assert/strict';
import test from 'node:test';
import { withFreshGroupPointsDb } from './group-points-db.js';
import { applyGroupPoints, pointState, seedMarket } from './group-points-support.js';

export function registerGroupPointsEligibilitySuite(): void {
  test('group-points RPC reports the strict market-not-found result without writing', async () => {
    // Given: a migrated database with no row for the requested market id.
    await withFreshGroupPointsDb(async (client) => {
      const missingMarketId = '00000000-0000-4000-8000-000000009999';

      // When: points application is requested for the absent market.
      const result = await applyGroupPoints(client, missingMarketId);

      // Then: the exact error code is returned and all private point stores remain empty.
      assert.deepEqual(result, { ok: false, code: 'market_not_found' });
      assert.deepEqual(await pointState(client), { events: [], stats: [], markers: [] });
    });
  });

  test('group-points RPC reports a missing settlement for an existing market', async () => {
    // Given: an existing SOL market with no persisted settlement fact.
    await withFreshGroupPointsDb(async (client) => {
      const fixture = await seedMarket(client, {
        groupId: -10_001,
        marketNumber: 10_001,
        callerUserId: 20_001,
      });

      // When: scoring is requested for that market.
      const result = await applyGroupPoints(client, fixture.marketId);

      // Then: the RPC distinguishes the missing settlement from a missing market.
      assert.deepEqual(result, { ok: false, code: 'settlement_missing' });
    });
  });

  test('group-points RPC excludes settlements before the group activation boundary', async () => {
    // Given: a terminal SOL market settled one instant before points activation.
    await withFreshGroupPointsDb(async (client) => {
      const fixture = await seedMarket(client, {
        groupId: -10_002,
        marketNumber: 10_002,
        callerUserId: 20_002,
        pointsStartedAt: '2026-01-02T00:00:00.000Z',
        status: 'settled',
        settlement: {
          outcome: 'claim_won',
          settledAt: '2026-01-01T23:59:59.999Z',
        },
      });

      // When: scoring is requested for the historical settlement.
      const result = await applyGroupPoints(client, fixture.marketId);

      // Then: the strict no-op result reports the activation reason and writes nothing.
      assert.deepEqual(result, {
        ok: true,
        eligible: false,
        duplicate: false,
        reason: 'pre_activation',
        group_id: fixture.groupId,
        scored_count: 0,
        winner_count: 0,
      });
      const writes = await client.query<{ readonly count: number }>(`
        select (
          (select count(*) from group_point_events)
          + (select count(*) from group_player_stats)
          + (select count(*) from group_points_applied)
        )::int as count
      `);
      assert.equal(writes.rows[0]?.count, 0);
    });
  });

  test('group-points RPC marks a void settlement exactly at activation without scoring users', async () => {
    // Given: a void SOL settlement whose timestamp equals the activation timestamp.
    await withFreshGroupPointsDb(async (client) => {
      const boundary = '2026-02-01T12:00:00.000Z';
      const fixture = await seedMarket(client, {
        groupId: -10_003,
        marketNumber: 10_003,
        callerUserId: 20_003,
        pointsStartedAt: boundary,
        status: 'voided',
        settlement: { outcome: 'void', settledAt: boundary },
      });

      // When: points application runs at the inclusive activation boundary.
      const result = await applyGroupPoints(client, fixture.marketId);

      // Then: the eligible result and marker are exact, with no user projection.
      assert.deepEqual(result, {
        ok: true,
        eligible: true,
        duplicate: false,
        reason: null,
        group_id: fixture.groupId,
        scored_count: 0,
        winner_count: 0,
      });
      const rows = await client.query<{
        readonly eventCount: number;
        readonly statsCount: number;
        readonly marketId: string;
        readonly groupId: string;
        readonly scoringVersion: number;
        readonly settledAtMs: string;
        readonly hasAppliedAt: boolean;
      }>(`
        select
          (select count(*)::int from group_point_events) as "eventCount",
          (select count(*)::int from group_player_stats) as "statsCount",
          a.market_id as "marketId",
          a.group_id::text as "groupId",
          a.scoring_version as "scoringVersion",
          (extract(epoch from a.settled_at) * 1000)::bigint::text as "settledAtMs",
          a.applied_at is not null as "hasAppliedAt"
        from group_points_applied a
        where a.market_id = $1
      `, [fixture.marketId]);
      assert.deepEqual(rows.rows, [{
        eventCount: 0,
        statsCount: 0,
        marketId: fixture.marketId,
        groupId: String(fixture.groupId),
        scoringVersion: 1,
        settledAtMs: String(Date.parse(boundary)),
        hasAppliedAt: true,
      }]);
    });
  });

  test('group-points RPC returns an exact duplicate result for an eligible market with no participants', async () => {
    // Given: an eligible settled market whose first application wrote only a marker.
    await withFreshGroupPointsDb(async (client) => {
      const fixture = await seedMarket(client, {
        groupId: -10_004,
        marketNumber: 10_004,
        callerUserId: 20_004,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        status: 'settled',
        settlement: {
          outcome: 'claim_won',
          settledAt: '2026-02-02T00:00:00.000Z',
        },
      });
      const first = await applyGroupPoints(client, fixture.marketId);
      assert.equal(first.ok && first.duplicate, false);

      // When: the same market is applied again.
      const duplicate = await applyGroupPoints(client, fixture.marketId);

      // Then: the RPC reports a duplicate and preserves the single marker.
      assert.deepEqual(duplicate, {
        ok: true,
        eligible: true,
        duplicate: true,
        reason: null,
        group_id: fixture.groupId,
        scored_count: 0,
        winner_count: 0,
      });
      const markerCount = await client.query<{ readonly count: number }>(
        'select count(*)::int as count from group_points_applied where market_id = $1',
        [fixture.marketId],
      );
      assert.equal(markerCount.rows[0]?.count, 1);
    });
  });

  test('group-points RPC excludes replay markets without an applied marker', async () => {
    // Given: a replay SOL market with a terminal post-activation settlement.
    await withFreshGroupPointsDb(async (client) => {
      const fixture = await seedMarket(client, {
        groupId: -10_005,
        marketNumber: 10_005,
        callerUserId: 20_005,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        replay: true,
        status: 'settled',
        settlement: {
          outcome: 'claim_lost',
          settledAt: '2026-02-03T00:00:00.000Z',
        },
      });

      // When: points application runs.
      const result = await applyGroupPoints(client, fixture.marketId);

      // Then: replay is an explicit no-op and no applied marker is created.
      assert.deepEqual(result, {
        ok: true,
        eligible: false,
        duplicate: false,
        reason: 'replay',
        group_id: fixture.groupId,
        scored_count: 0,
        winner_count: 0,
      });
      const markerCount = await client.query<{ readonly count: number }>(
        'select count(*)::int as count from group_points_applied',
      );
      assert.equal(markerCount.rows[0]?.count, 0);
    });
  });

  test('group-points RPC excludes non-SOL markets without an applied marker', async () => {
    // Given: a terminal post-activation market in the unsupported legacy currency.
    await withFreshGroupPointsDb(async (client) => {
      const fixture = await seedMarket(client, {
        groupId: -10_006,
        marketNumber: 10_006,
        callerUserId: 20_006,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        currency: 'rep',
        status: 'settled',
        settlement: {
          outcome: 'claim_won',
          settledAt: '2026-02-04T00:00:00.000Z',
        },
      });

      // When: points application runs.
      const result = await applyGroupPoints(client, fixture.marketId);

      // Then: the unsupported market is a successful no-op with no marker.
      assert.deepEqual(result, {
        ok: true,
        eligible: false,
        duplicate: false,
        reason: 'unsupported_market',
        group_id: fixture.groupId,
        scored_count: 0,
        winner_count: 0,
      });
      const markerCount = await client.query<{ readonly count: number }>(
        'select count(*)::int as count from group_points_applied',
      );
      assert.equal(markerCount.rows[0]?.count, 0);
    });
  });
}
