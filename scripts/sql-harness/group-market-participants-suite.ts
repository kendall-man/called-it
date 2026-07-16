import assert from 'node:assert/strict';
import test from 'node:test';
import { withFreshGroupPointsDb } from './group-points-db.js';
import { seedMarket, type MarketFixture } from './group-points-support.js';

type ParticipantRow = {
  readonly groupId: string;
  readonly marketId: string;
  readonly userId: string;
  readonly side: string;
  readonly firstPlacedAtMs: string;
  readonly displayName: string;
  readonly username: string | null;
  readonly participantCount: number;
};

type ExpectedParticipant = {
  readonly fixture: MarketFixture;
  readonly userId: number;
  readonly side: 'back' | 'doubt';
  readonly firstPlacedAtMs: number;
  readonly displayName: string;
  readonly username: string | null;
  readonly participantCount: number;
};

export function registerGroupMarketParticipantsSuite(): void {
  test('participant RPC deduplicates before each side limit and isolates market groups', async () => {
    // Given: five early duplicate placements, later distinct users, both states/sides, and another group.
    await withFreshGroupPointsDb(async (client) => {
      const primary = await seedMarket(client, {
        groupId: -11_001,
        marketNumber: 11_001,
        callerUserId: 21_001,
      });
      const other = await seedMarket(client, {
        groupId: -11_002,
        marketNumber: 11_002,
        callerUserId: 21_002,
      });
      await client.query(`
        insert into users (id, display_name, username) values
          (31001, 'Back One', 'back_one'),
          (31002, 'Back Two', null),
          (31003, 'Back Three', null),
          (31004, 'Back Four', null),
          (31005, 'Back Five', null),
          (31006, 'Back Six', null),
          (31007, 'Back Seven', null),
          (31999, 'Void Only', null),
          (32001, 'Doubt Only', 'doubt_only'),
          (33001, 'Other Group', null)
      `);
      await client.query(
        `insert into positions
          (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms)
        values
          ($1, 31001, 'back', 10000000, 2, 'active', 1),
          ($1, 31001, 'back', 10000000, 2, 'active', 2),
          ($1, 31001, 'back', 10000000, 2, 'pending', 3),
          ($1, 31001, 'back', 10000000, 2, 'active', 4),
          ($1, 31001, 'back', 10000000, 2, 'pending', 5),
          ($1, 31002, 'back', 10000000, 2, 'void', 0),
          ($1, 31002, 'back', 10000000, 2, 'pending', 10),
          ($1, 31003, 'back', 10000000, 2, 'active', 10),
          ($1, 31004, 'back', 10000000, 2, 'active', 11),
          ($1, 31005, 'back', 10000000, 2, 'pending', 12),
          ($1, 31006, 'back', 10000000, 2, 'active', 13),
          ($1, 31007, 'back', 10000000, 2, 'active', 14),
          ($1, 31999, 'back', 10000000, 2, 'void', 0),
          ($1, 32001, 'doubt', 10000000, 2, 'pending', 2),
          ($1, 32001, 'doubt', 10000000, 2, 'active', 3),
          ($2, 31001, 'back', 10000000, 2, 'active', 0),
          ($2, 33001, 'doubt', 10000000, 2, 'active', 1)`,
        [primary.marketId, other.marketId],
      );

      // When: both market-scoped participant projections are loaded through the SQL interface.
      const [primaryRows, otherRows] = await Promise.all([
        participantRows(client, primary.marketId),
        participantRows(client, other.marketId),
      ]);

      // Then: distinct totals precede the cap, ties are stable, voids are absent, and groups never mix.
      assert.deepEqual(primaryRows, [
        participant({
          fixture: primary, userId: 31001, side: 'back', firstPlacedAtMs: 1,
          displayName: 'Back One', username: 'back_one', participantCount: 7,
        }),
        participant({
          fixture: primary, userId: 32001, side: 'doubt', firstPlacedAtMs: 2,
          displayName: 'Doubt Only', username: 'doubt_only', participantCount: 1,
        }),
        participant({
          fixture: primary, userId: 31002, side: 'back', firstPlacedAtMs: 10,
          displayName: 'Back Two', username: null, participantCount: 7,
        }),
        participant({
          fixture: primary, userId: 31003, side: 'back', firstPlacedAtMs: 10,
          displayName: 'Back Three', username: null, participantCount: 7,
        }),
        participant({
          fixture: primary, userId: 31004, side: 'back', firstPlacedAtMs: 11,
          displayName: 'Back Four', username: null, participantCount: 7,
        }),
        participant({
          fixture: primary, userId: 31005, side: 'back', firstPlacedAtMs: 12,
          displayName: 'Back Five', username: null, participantCount: 7,
        }),
      ]);
      assert.deepEqual(otherRows, [
        participant({
          fixture: other, userId: 31001, side: 'back', firstPlacedAtMs: 0,
          displayName: 'Back One', username: 'back_one', participantCount: 1,
        }),
        participant({
          fixture: other, userId: 33001, side: 'doubt', firstPlacedAtMs: 1,
          displayName: 'Other Group', username: null, participantCount: 1,
        }),
      ]);
    });
  });
}

async function participantRows(
  client: import('pg').Client,
  marketId: string,
): Promise<readonly ParticipantRow[]> {
  const result = await client.query<ParticipantRow>(
    `select
       group_id::text as "groupId",
       market_id::text as "marketId",
       user_id::text as "userId",
       side,
       first_placed_at_ms::text as "firstPlacedAtMs",
       display_name as "displayName",
       username,
       participant_count as "participantCount"
     from group_market_participants($1)`,
    [marketId],
  );
  return result.rows;
}

function participant(input: ExpectedParticipant): ParticipantRow {
  return {
    groupId: String(input.fixture.groupId),
    marketId: input.fixture.marketId,
    userId: String(input.userId),
    side: input.side,
    firstPlacedAtMs: String(input.firstPlacedAtMs),
    displayName: input.displayName,
    username: input.username,
    participantCount: input.participantCount,
  };
}
