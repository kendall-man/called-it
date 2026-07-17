import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client } from 'pg';
import { groupPointsMigrations, withGroupPointsDb } from './group-points-db.js';
import { withPgClient } from './postgres.js';
import { seedMarket } from './group-points-support.js';

export function registerGroupMarketParticipantsMigrationSuite(): void {
  test('participant migration upgrades 0015 with an exact private service-role RPC', async () => {
    // Given: a populated schema at 0015 and the forward participant migration.
    const migrations = await groupPointsMigrations();
    const participantMigration = migrations.find(
      (migration) => migration.name === '0016_group_market_participants.sql',
    );
    assert.ok(participantMigration);
    const previousMigrations = migrations.filter(
      (migration) => migration.name < participantMigration.name,
    );
    assert.equal(previousMigrations.at(-1)?.name, '0015_starter_only_beta.sql');

    await withGroupPointsDb(previousMigrations, async (client, connectionString) => {
      const fixture = await seedMarket(client, {
        groupId: -11_003,
        marketNumber: 11_003,
        callerUserId: 21_003,
      });
      await client.query(
        "insert into users (id, display_name, username) values (34001, 'Upgrade User', 'upgrade_user')",
      );
      await client.query(
        `insert into positions
          (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms)
         values ($1, 34001, 'back', 10000000, 2, 'pending', 42)`,
        [fixture.marketId],
      );
      const before = await client.query<{ readonly functionName: string | null }>(
        "select to_regprocedure('public.group_market_participants(uuid)')::text as \"functionName\"",
      );
      assert.equal(before.rows[0]?.functionName, null);

      // When: 0016 is applied over existing markets, users, and positions.
      await client.query(participantMigration.sql);

      // Then: its catalog shape, RLS dependencies, grants, and role behavior are exact.
      await assertParticipantFunctionContract(client);
      await assertParticipantTablesUseRls(client);
      for (const role of ['anon', 'authenticated'] as const) {
        await withPgClient(connectionString, async (roleClient) => {
          await roleClient.query(`set role ${role}`);
          await assert.rejects(
            roleClient.query('select * from group_market_participants($1)', [fixture.marketId]),
            /permission denied/,
          );
        });
      }
      await withPgClient(connectionString, async (roleClient) => {
        await roleClient.query('set role service_role');
        const rows = await roleClient.query<{
          readonly userId: string;
          readonly participantCount: number;
        }>(
          `select user_id::text as "userId", participant_count as "participantCount"
           from group_market_participants($1)`,
          [fixture.marketId],
        );
        assert.deepEqual(rows.rows, [{ userId: '34001', participantCount: 1 }]);
      });
    });
  });
}

async function assertParticipantFunctionContract(client: Client): Promise<void> {
  const functions = await client.query<{
    readonly signature: string;
    readonly result: string;
    readonly securityDefiner: boolean;
    readonly volatility: string;
    readonly config: readonly string[] | null;
    readonly publicExecute: boolean;
    readonly anonExecute: boolean;
    readonly authenticatedExecute: boolean;
    readonly serviceExecute: boolean;
  }>(`
    select
      p.oid::regprocedure::text as signature,
      pg_get_function_result(p.oid) as result,
      p.prosecdef as "securityDefiner",
      p.provolatile as volatility,
      p.proconfig as config,
      has_function_privilege('public', p.oid, 'execute') as "publicExecute",
      has_function_privilege('anon', p.oid, 'execute') as "anonExecute",
      has_function_privilege('authenticated', p.oid, 'execute') as "authenticatedExecute",
      has_function_privilege('service_role', p.oid, 'execute') as "serviceExecute"
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'group_market_participants'
  `);
  assert.deepEqual(functions.rows, [
    {
      signature: 'group_market_participants(uuid)',
      result:
        'TABLE(group_id bigint, market_id uuid, user_id bigint, side text, first_placed_at_ms bigint, display_name text, username text, participant_count integer)',
      securityDefiner: true,
      volatility: 's',
      config: ['search_path=pg_catalog, public'],
      publicExecute: false,
      anonExecute: false,
      authenticatedExecute: false,
      serviceExecute: true,
    },
  ]);
}

async function assertParticipantTablesUseRls(client: Client): Promise<void> {
  const rls = await client.query<{ readonly tableName: string; readonly enabled: boolean }>(`
    select c.relname as "tableName", c.relrowsecurity as enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any($1::text[])
    order by c.relname
  `, [['markets', 'positions', 'users']]);
  assert.deepEqual(rls.rows, [
    { tableName: 'markets', enabled: true },
    { tableName: 'positions', enabled: true },
    { tableName: 'users', enabled: true },
  ]);
}
