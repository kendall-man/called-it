import assert from 'node:assert/strict';
import test from 'node:test';
import { withFreshGroupPointsDb } from './group-points-db.js';

export function registerGroupPointsSchemaSuite(): void {
  test('group-points migration creates the activation, ledger, projection, marker, and RPC contract', async () => {
    // Given: a database created from every tracked migration.
    // When: the migrations are applied to a fresh disposable PostgreSQL database.
    await withFreshGroupPointsDb(async (client) => {
      const objects = await client.query<{ readonly name: string }>(`
        select table_name as name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in ('group_point_events', 'group_player_stats', 'group_points_applied')
        union all
        select column_name as name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'groups'
          and column_name = 'points_started_at'
        union all
        select routine_name as name
        from information_schema.routines
        where routine_schema = 'public'
          and routine_name = 'group_points_apply'
        order by name
      `);

      // Then: the complete public SQL interface exists.
      assert.deepEqual(objects.rows.map((row) => row.name), [
        'group_player_stats',
        'group_point_events',
        'group_points_applied',
        'group_points_apply',
        'points_started_at',
      ]);
      const activation = await client.query<{
        readonly dataType: string;
        readonly nullable: string;
        readonly defaultExpression: string | null;
      }>(`
        select
          data_type as "dataType",
          is_nullable as nullable,
          column_default as "defaultExpression"
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'groups'
          and column_name = 'points_started_at'
      `);
      assert.deepEqual(activation.rows, [{
        dataType: 'timestamp with time zone',
        nullable: 'NO',
        defaultExpression: 'clock_timestamp()',
      }]);
      const tableColumns = await client.query<{
        readonly tableName: string;
        readonly columns: readonly string[];
      }>(`
        select table_name as "tableName", array_agg(column_name::text order by ordinal_position) as columns
        from information_schema.columns
        where table_schema = 'public'
          and table_name = any($1::text[])
        group by table_name
        order by table_name
      `, [['group_point_events', 'group_player_stats', 'group_points_applied']]);
      assert.deepEqual(tableColumns.rows, [
        {
          tableName: 'group_player_stats',
          columns: ['group_id', 'user_id', 'points', 'wins', 'losses', 'current_streak', 'best_streak', 'updated_at'],
        },
        {
          tableName: 'group_point_events',
          columns: ['group_id', 'market_id', 'user_id', 'side', 'result', 'points_delta', 'scoring_version', 'settled_at'],
        },
        {
          tableName: 'group_points_applied',
          columns: ['market_id', 'group_id', 'scoring_version', 'settled_at', 'applied_at'],
        },
      ]);
      const indexes = await client.query<{
        readonly indexName: string;
        readonly definition: string;
      }>(`
        select indexname as "indexName", indexdef as definition
        from pg_indexes
        where schemaname = 'public'
          and indexname = any($1::text[])
        order by indexname
      `, [['group_player_stats_leaderboard_idx', 'group_point_events_player_history_idx']]);
      const historyIndex = indexes.rows.find(
        (row) => row.indexName === 'group_point_events_player_history_idx',
      );
      const leaderboardIndex = indexes.rows.find(
        (row) => row.indexName === 'group_player_stats_leaderboard_idx',
      );
      assert.ok(historyIndex);
      assert.ok(leaderboardIndex);
      assert.match(historyIndex.definition, /\(group_id, user_id, settled_at, market_id\)$/);
      assert.match(
        leaderboardIndex.definition,
        /\(group_id, points DESC, wins DESC, losses, user_id\)$/,
      );
    });
  });
}
