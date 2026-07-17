import assert from 'node:assert/strict';
import test from 'node:test';
import { withPgClient } from './postgres.js';
import { withFreshGroupPointsDb } from './group-points-db.js';
import {
  PRIVATE_PUBLIC_COLUMN,
  PUBLIC_GROUP_BOARD_COLUMNS,
  PUBLIC_RECEIPT_COLUMNS,
} from './group-points-security-contract.js';
import { applyGroupPoints, seedMarket } from './group-points-support.js';

export function registerGroupPointsSecuritySuite(): void {
  test('group-points tables and RPC expose only the exact private service-role contract', async () => {
    // Given: a fresh migrated database and one eligible market for the role probes.
    await withFreshGroupPointsDb(async (client, connectionString) => {
      const fixture = await seedMarket(client, {
        groupId: -10_008,
        marketNumber: 10_008,
        callerUserId: 20_008,
        pointsStartedAt: '2026-02-01T00:00:00.000Z',
        status: 'settled',
        settlement: { outcome: 'claim_won', settledAt: '2026-02-05T00:00:00.000Z' },
      });

      // When: PostgreSQL reports schema, public-view, table, policy, and function security metadata.
      const schemaPrivileges = await client.query<{
        readonly roleName: string;
        readonly canCreate: boolean;
        readonly canUse: boolean;
      }>(`
        select
          role_name as "roleName",
          has_schema_privilege(role_name, 'public', 'create') as "canCreate",
          has_schema_privilege(role_name, 'public', 'usage') as "canUse"
        from (values ('anon'), ('authenticated'), ('public'), ('service_role')) roles(role_name)
        order by role_name
      `);
      assert.deepEqual(schemaPrivileges.rows, [
        { roleName: 'anon', canCreate: false, canUse: true },
        { roleName: 'authenticated', canCreate: false, canUse: true },
        { roleName: 'public', canCreate: false, canUse: true },
        { roleName: 'service_role', canCreate: false, canUse: true },
      ]);

      const viewColumns = await client.query<{
        readonly viewName: string;
        readonly columnName: string;
      }>(`
        select table_name as "viewName", column_name as "columnName"
        from information_schema.columns
        where table_schema = 'public'
          and table_name = any($1::text[])
        order by table_name, column_name
      `, [['public_receipts', 'public_group_board']]);
      const columnsFor = (viewName: string) => viewColumns.rows
        .filter((row) => row.viewName === viewName)
        .map((row) => row.columnName);
      assert.deepEqual(columnsFor('public_receipts'), [...PUBLIC_RECEIPT_COLUMNS].sort());
      assert.deepEqual(columnsFor('public_group_board'), [...PUBLIC_GROUP_BOARD_COLUMNS].sort());
      for (const column of viewColumns.rows) {
        assert.equal(
          PRIVATE_PUBLIC_COLUMN.test(column.columnName),
          false,
          `${column.viewName}.${column.columnName} exposes private identity or points data`,
        );
      }

      const tables = await client.query<{
        readonly tableName: string;
        readonly rls: boolean;
        readonly publicAny: boolean;
        readonly anonAny: boolean;
        readonly authenticatedAny: boolean;
        readonly serviceSelect: boolean;
        readonly serviceInsert: boolean;
        readonly serviceUpdate: boolean;
        readonly serviceDelete: boolean;
        readonly serviceTruncate: boolean;
        readonly serviceReferences: boolean;
        readonly serviceTrigger: boolean;
      }>(`
        select
          c.relname as "tableName",
          c.relrowsecurity as rls,
          has_table_privilege('public', c.oid, 'select')
            or has_table_privilege('public', c.oid, 'insert')
            or has_table_privilege('public', c.oid, 'update')
            or has_table_privilege('public', c.oid, 'delete')
            or has_table_privilege('public', c.oid, 'truncate')
            or has_table_privilege('public', c.oid, 'references')
            or has_table_privilege('public', c.oid, 'trigger') as "publicAny",
          has_table_privilege('anon', c.oid, 'select')
            or has_table_privilege('anon', c.oid, 'insert')
            or has_table_privilege('anon', c.oid, 'update')
            or has_table_privilege('anon', c.oid, 'delete')
            or has_table_privilege('anon', c.oid, 'truncate')
            or has_table_privilege('anon', c.oid, 'references')
            or has_table_privilege('anon', c.oid, 'trigger') as "anonAny",
          has_table_privilege('authenticated', c.oid, 'select')
            or has_table_privilege('authenticated', c.oid, 'insert')
            or has_table_privilege('authenticated', c.oid, 'update')
            or has_table_privilege('authenticated', c.oid, 'delete')
            or has_table_privilege('authenticated', c.oid, 'truncate')
            or has_table_privilege('authenticated', c.oid, 'references')
            or has_table_privilege('authenticated', c.oid, 'trigger') as "authenticatedAny",
          has_table_privilege('service_role', c.oid, 'select') as "serviceSelect",
          has_table_privilege('service_role', c.oid, 'insert') as "serviceInsert",
          has_table_privilege('service_role', c.oid, 'update') as "serviceUpdate",
          has_table_privilege('service_role', c.oid, 'delete') as "serviceDelete",
          has_table_privilege('service_role', c.oid, 'truncate') as "serviceTruncate",
          has_table_privilege('service_role', c.oid, 'references') as "serviceReferences",
          has_table_privilege('service_role', c.oid, 'trigger') as "serviceTrigger"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = any($1::text[])
        order by c.relname
      `, [['group_point_events', 'group_player_stats', 'group_points_applied']]);
      const privateTable = (tableName: string) => ({
        tableName,
        rls: true,
        publicAny: false,
        anonAny: false,
        authenticatedAny: false,
        serviceSelect: true,
        serviceInsert: false,
        serviceUpdate: false,
        serviceDelete: false,
        serviceTruncate: false,
        serviceReferences: false,
        serviceTrigger: false,
      });
      assert.deepEqual(tables.rows, [
        privateTable('group_player_stats'),
        privateTable('group_point_events'),
        privateTable('group_points_applied'),
      ]);
      const policies = await client.query<{ readonly tableName: string }>(`
        select tablename as "tableName"
        from pg_policies
        where schemaname = 'public'
          and tablename = any($1::text[])
      `, [['group_point_events', 'group_player_stats', 'group_points_applied']]);
      assert.deepEqual(policies.rows, []);
      const functions = await client.query<{
        readonly signature: string;
        readonly securityDefiner: boolean;
        readonly config: readonly string[] | null;
        readonly publicExecute: boolean;
        readonly anonExecute: boolean;
        readonly authenticatedExecute: boolean;
        readonly serviceExecute: boolean;
      }>(`
        select
          p.oid::regprocedure::text as signature,
          p.prosecdef as "securityDefiner",
          p.proconfig as config,
          has_function_privilege('public', p.oid, 'execute') as "publicExecute",
          has_function_privilege('anon', p.oid, 'execute') as "anonExecute",
          has_function_privilege('authenticated', p.oid, 'execute') as "authenticatedExecute",
          has_function_privilege('service_role', p.oid, 'execute') as "serviceExecute"
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'group_points_apply'
      `);
      assert.deepEqual(functions.rows, [{
        signature: 'group_points_apply(uuid)',
        securityDefiner: true,
        config: ['search_path=pg_catalog, public'],
        publicExecute: false,
        anonExecute: false,
        authenticatedExecute: false,
        serviceExecute: true,
      }]);

      // Then: public roles fail at both surfaces while service_role can invoke the RPC.
      for (const role of ['anon', 'authenticated'] as const) {
        await withPgClient(connectionString, async (roleClient) => {
          await roleClient.query(`set role ${role}`);
          await assert.rejects(
            roleClient.query('select * from group_point_events'),
            /permission denied/,
          );
          await assert.rejects(
            roleClient.query('select group_points_apply($1)', [fixture.marketId]),
            /permission denied/,
          );
        });
      }
      await withPgClient(connectionString, async (roleClient) => {
        await roleClient.query('set role service_role');
        assert.deepEqual(await applyGroupPoints(roleClient, fixture.marketId), {
          ok: true,
          eligible: true,
          duplicate: false,
          reason: null,
          group_id: fixture.groupId,
          scored_count: 0,
          winner_count: 0,
        });
      });
    });
  });
}
