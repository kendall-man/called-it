import { type Client, type Pool } from 'pg';

export type GroupPointsApplyResult =
  | {
      readonly ok: false;
      readonly code: 'market_not_found' | 'settlement_missing' | 'position_conflict';
    }
  | {
      readonly ok: true;
      readonly eligible: boolean;
      readonly duplicate: boolean;
      readonly reason: null | 'pre_activation' | 'replay' | 'unsupported_market';
      readonly group_id: number;
      readonly scored_count: number;
      readonly winner_count: number;
    };

export type MarketFixture = {
  readonly groupId: number;
  readonly marketId: string;
  readonly callerUserId: number;
};

type MarketStatus = 'open' | 'settled' | 'voided';
type SettlementOutcome = 'claim_won' | 'claim_lost' | 'void';

export type SeedMarketInput = {
  readonly groupId: number;
  readonly marketNumber: number;
  readonly callerUserId: number;
  readonly pointsStartedAt?: string;
  readonly currency?: 'rep' | 'sol';
  readonly replay?: boolean;
  readonly status?: MarketStatus;
  readonly settlement?: {
    readonly outcome: SettlementOutcome;
    readonly settledAt: string;
  };
};

export type PointState = {
  readonly events: readonly {
    readonly groupId: string;
    readonly marketId: string;
    readonly userId: string;
    readonly side: string;
    readonly result: string;
    readonly pointsDelta: string;
    readonly scoringVersion: number;
    readonly settledAtMs: string;
  }[];
  readonly stats: readonly {
    readonly groupId: string;
    readonly userId: string;
    readonly points: string;
    readonly wins: string;
    readonly losses: string;
    readonly currentStreak: string;
    readonly bestStreak: string;
    readonly updatedAtMs: string;
  }[];
  readonly markers: readonly {
    readonly marketId: string;
    readonly groupId: string;
    readonly scoringVersion: number;
    readonly settledAtMs: string;
  }[];
};

export async function seedMarket(client: Client, input: SeedMarketInput): Promise<MarketFixture> {
  const marketId = marketIdFor(input.marketNumber);
  await client.query(
    'insert into groups (id, title, slug) values ($1, $2, $3) on conflict (id) do nothing',
    [input.groupId, 'group', `group-${Math.abs(input.groupId)}`],
  );
  if (input.pointsStartedAt !== undefined) {
    await client.query('update groups set points_started_at = $1 where id = $2', [
      input.pointsStartedAt,
      input.groupId,
    ]);
  }
  await client.query(
    'insert into users (id, display_name) values ($1, $2) on conflict (id) do nothing',
    [input.callerUserId, `user-${input.callerUserId}`],
  );
  await client.query(
    'insert into fixtures (fixture_id) values ($1) on conflict (fixture_id) do nothing',
    [input.marketNumber],
  );
  const claim = await client.query<{ readonly id: string }>(
    'insert into claims (group_id, claimer_user_id, tg_message_id, quoted_text) values ($1, $2, $3, $4) returning id',
    [input.groupId, input.callerUserId, input.marketNumber, 'claim'],
  );
  const claimRow = claim.rows[0];
  if (claimRow === undefined) {
    throw new Error('group-points fixture claim insert returned no row');
  }
  await client.query(
    `insert into markets
      (id, claim_id, group_id, fixture_id, spec, status, is_replay,
       price_provenance, quote_probability, quote_multiplier, currency)
     values ($1, $2, $3, $4, '{}'::jsonb, $5, $6, 'modelled', 0.5, 2, $7)`,
    [
      marketId,
      claimRow.id,
      input.groupId,
      input.marketNumber,
      input.status ?? 'open',
      input.replay ?? false,
      input.currency ?? 'sol',
    ],
  );
  if (input.settlement !== undefined) {
    await client.query(
      `insert into settlements (market_id, outcome, tier, settled_at)
       values ($1, $2, 'oracle_resolved', $3)`,
      [marketId, input.settlement.outcome, input.settlement.settledAt],
    );
  }
  return { groupId: input.groupId, marketId, callerUserId: input.callerUserId };
}

export async function applyGroupPoints(
  client: Client,
  marketId: string,
): Promise<GroupPointsApplyResult> {
  const result = await client.query<{ readonly result: GroupPointsApplyResult }>(
    'select group_points_apply($1) as result',
    [marketId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('group_points_apply returned no row');
  }
  return row.result;
}

export async function poolApplyGroupPoints(
  pool: Pool,
  marketId: string,
): Promise<GroupPointsApplyResult> {
  const result = await pool.query<{ readonly result: GroupPointsApplyResult }>(
    'select group_points_apply($1) as result',
    [marketId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('group_points_apply returned no pooled row');
  }
  return row.result;
}

export async function addPositions(
  client: Client,
  fixture: MarketFixture,
  input: {
    readonly userId: number;
    readonly side: 'back' | 'doubt';
    readonly state?: 'pending' | 'active' | 'void';
    readonly count?: number;
  },
): Promise<void> {
  await client.query(
    'insert into users (id, display_name) values ($1, $2) on conflict (id) do nothing',
    [input.userId, `user-${input.userId}`],
  );
  const count = input.count ?? 1;
  for (let index = 0; index < count; index += 1) {
    await client.query(
      `insert into positions
        (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms)
       values ($1, $2, $3, 10000000, 2, $4, $5)`,
      [fixture.marketId, input.userId, input.side, input.state ?? 'active', index + 1],
    );
  }
}

export async function pointState(client: Client): Promise<PointState> {
  const events = await client.query<PointState['events'][number]>(`
      select group_id::text as "groupId", market_id as "marketId", user_id::text as "userId",
        side, result, points_delta::text as "pointsDelta", scoring_version as "scoringVersion",
        (extract(epoch from settled_at) * 1000)::bigint::text as "settledAtMs"
      from group_point_events
      order by group_id, settled_at, market_id, user_id
    `);
  const stats = await client.query<PointState['stats'][number]>(`
      select group_id::text as "groupId", user_id::text as "userId", points::text, wins::text,
        losses::text, current_streak::text as "currentStreak", best_streak::text as "bestStreak",
        (extract(epoch from updated_at) * 1000)::bigint::text as "updatedAtMs"
      from group_player_stats
      order by group_id, user_id
    `);
  const markers = await client.query<PointState['markers'][number]>(`
      select market_id as "marketId", group_id::text as "groupId", scoring_version as "scoringVersion",
        (extract(epoch from settled_at) * 1000)::bigint::text as "settledAtMs"
      from group_points_applied
      order by group_id, settled_at, market_id
    `);
  return { events: events.rows, stats: stats.rows, markers: markers.rows };
}

function marketIdFor(marketNumber: number): string {
  return `00000000-0000-4000-8000-${String(marketNumber).padStart(12, '0')}`;
}
