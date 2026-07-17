import assert from 'node:assert/strict';
import test from 'node:test';
import { withFreshGroupPointsDb } from './group-points-db.js';
import { addPositions, applyGroupPoints, pointState, seedMarket } from './group-points-support.js';

export function registerGroupPointsIntegritySuite(): void {
  test('group-points RPC rolls back every participant when one user has active positions on both sides', async () => {
    // Given: an eligible market with one valid participant and one corrupt two-sided participant.
    await withFreshGroupPointsDb(async (client) => {
      const fixture = await seedMarket(client, {
        groupId: -13_000,
        marketNumber: 13_001,
        callerUserId: 23_000,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        status: 'settled',
        settlement: { outcome: 'claim_lost', settledAt: '2026-02-10T00:00:00.000Z' },
      });
      await addPositions(client, fixture, { userId: 33_001, side: 'doubt' });
      await addPositions(client, fixture, { userId: 33_002, side: 'back' });
      await addPositions(client, fixture, { userId: 33_002, side: 'doubt' });
      const before = await pointState(client);

      // When: the corrupt persisted market is submitted to the scoring RPC.
      const result = await applyGroupPoints(client, fixture.marketId);

      // Then: it fails closed and even the valid participant remains unscored and unmarked.
      assert.deepEqual(result, { ok: false, code: 'position_conflict' });
      assert.deepEqual(await pointState(client), before);
    });
  });

  test('group-points RPC fails closed on opposite-side corruption before marking a void market', async () => {
    // Given: a void settlement whose persisted active positions contain a two-sided user.
    await withFreshGroupPointsDb(async (client) => {
      const fixture = await seedMarket(client, {
        groupId: -13_100,
        marketNumber: 13_101,
        callerUserId: 23_100,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        status: 'voided',
        settlement: { outcome: 'void', settledAt: '2026-02-10T00:00:00.000Z' },
      });
      await addPositions(client, fixture, { userId: 33_101, side: 'back' });
      await addPositions(client, fixture, { userId: 33_101, side: 'doubt' });
      const before = await pointState(client);

      // When: scoring inspects the corrupt void market.
      const result = await applyGroupPoints(client, fixture.marketId);

      // Then: corruption wins over the normal marker-only void path and no write survives.
      assert.deepEqual(result, { ok: false, code: 'position_conflict' });
      assert.deepEqual(await pointState(client), before);
    });
  });

  test('group-points RPC rolls back events and projections when the final applied marker insert fails', async () => {
    // Given: an eligible winner and an injected failure on the marker written last by the RPC.
    await withFreshGroupPointsDb(async (client) => {
      const fixture = await seedMarket(client, {
        groupId: -14_000,
        marketNumber: 14_001,
        callerUserId: 24_000,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        status: 'settled',
        settlement: { outcome: 'claim_won', settledAt: '2026-02-11T00:00:00.000Z' },
      });
      await addPositions(client, fixture, { userId: 34_001, side: 'back' });
      await client.query(`
        create function fail_group_points_marker() returns trigger
        language plpgsql
        as $$
        begin
          raise exception 'injected group-points marker failure';
        end;
        $$
      `);
      await client.query(`
        create trigger fail_group_points_marker
        before insert on group_points_applied
        for each row execute function fail_group_points_marker()
      `);

      // When: the final marker insert raises after event and projection work.
      await assert.rejects(
        applyGroupPoints(client, fixture.marketId),
        /injected group-points marker failure/,
      );

      // Then: PostgreSQL rolls the complete RPC statement back atomically.
      await client.query('drop trigger fail_group_points_marker on group_points_applied');
      await client.query('drop function fail_group_points_marker()');
      assert.deepEqual(await pointState(client), { events: [], stats: [], markers: [] });
    });
  });
}
