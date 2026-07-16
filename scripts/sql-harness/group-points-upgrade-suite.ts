import assert from 'node:assert/strict';
import test from 'node:test';
import { groupPointsMigrations, withGroupPointsDb } from './group-points-db.js';
import { addPositions, applyGroupPoints, pointState, seedMarket } from './group-points-support.js';

export function registerGroupPointsUpgradeSuite(): void {
  test('group-points migration upgrades 0001-0013 without scoring history and defaults future groups at creation', async () => {
    // Given: a group with a settled call created through the complete pre-points schema.
    const migrations = await groupPointsMigrations();
    const groupPointsMigration = migrations.find(
      (migration) => migration.name === '0014_group_points.sql',
    );
    assert.ok(groupPointsMigration);
    const previousMigrations = migrations.filter(
      (migration) => migration.name < groupPointsMigration.name,
    );
    assert.equal(previousMigrations.at(-1)?.name, '0013_direct_beta_starter.sql');

    await withGroupPointsDb(previousMigrations, async (client) => {
      const historical = await seedMarket(client, {
        groupId: -10_000,
        marketNumber: 10_000,
        callerUserId: 20_000,
        status: 'settled',
        settlement: {
          outcome: 'claim_won',
          settledAt: '2026-01-01T00:00:00.000Z',
        },
      });
      await addPositions(client, historical, { userId: 30_000, side: 'back' });
      await client.query('grant create on schema public to public');
      await client.query(`
        alter default privileges in schema public
        grant all privileges on tables to anon, authenticated, service_role
      `);
      const legacySchemaPrivileges = await client.query<{
        readonly roleName: string;
        readonly canCreate: boolean;
      }>(`
        select
          role_name as "roleName",
          has_schema_privilege(role_name, 'public', 'create') as "canCreate"
        from (values ('anon'), ('authenticated'), ('public'), ('service_role')) roles(role_name)
        order by role_name
      `);
      assert.deepEqual(legacySchemaPrivileges.rows, [
        { roleName: 'anon', canCreate: true },
        { roleName: 'authenticated', canCreate: true },
        { roleName: 'public', canCreate: true },
        { roleName: 'service_role', canCreate: true },
      ]);
      const beforeUpgrade = await client.query<{ readonly micros: string }>(
        "select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as micros",
      );

      // When: the forward-only group-points migration is applied to the populated schema.
      await client.query(groupPointsMigration.sql);

      // Then: the existing group activates during the upgrade and its old settlement remains unscored.
      const afterUpgrade = await client.query<{
        readonly pointsStartedAtMicros: string;
        readonly micros: string;
      }>(`
        select
          (extract(epoch from g.points_started_at) * 1000000)::bigint::text as "pointsStartedAtMicros",
          (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as micros
        from groups g
        where g.id = $1
      `, [historical.groupId]);
      const beforeMicros = beforeUpgrade.rows[0]?.micros;
      const upgradedRow = afterUpgrade.rows[0];
      assert.ok(beforeMicros);
      assert.ok(upgradedRow);
      assert.ok(BigInt(upgradedRow.pointsStartedAtMicros) >= BigInt(beforeMicros));
      assert.ok(BigInt(upgradedRow.pointsStartedAtMicros) <= BigInt(upgradedRow.micros));
      const upgradedSchemaPrivileges = await client.query<{
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
      assert.deepEqual(upgradedSchemaPrivileges.rows, [
        { roleName: 'anon', canCreate: false, canUse: true },
        { roleName: 'authenticated', canCreate: false, canUse: true },
        { roleName: 'public', canCreate: false, canUse: true },
        { roleName: 'service_role', canCreate: false, canUse: true },
      ]);
      const upgradedTablePrivileges = await client.query<{
        readonly tableName: string;
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
      const upgradedPrivateTable = (tableName: string) => ({
        tableName,
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
      assert.deepEqual(upgradedTablePrivileges.rows, [
        upgradedPrivateTable('group_player_stats'),
        upgradedPrivateTable('group_point_events'),
        upgradedPrivateTable('group_points_applied'),
      ]);
      await client.query('create table unrelated_default_acl_probe (id bigint primary key)');
      const futureTableDefaults = await client.query<{
        readonly roleName: string;
        readonly canSelect: boolean;
        readonly canInsert: boolean;
      }>(`
        select
          role_name as "roleName",
          has_table_privilege(role_name, 'public.unrelated_default_acl_probe', 'select') as "canSelect",
          has_table_privilege(role_name, 'public.unrelated_default_acl_probe', 'insert') as "canInsert"
        from (values ('anon'), ('authenticated'), ('service_role')) roles(role_name)
        order by role_name
      `);
      assert.deepEqual(futureTableDefaults.rows, [
        { roleName: 'anon', canSelect: true, canInsert: true },
        { roleName: 'authenticated', canSelect: true, canInsert: true },
        { roleName: 'service_role', canSelect: true, canInsert: true },
      ]);
      await client.query('drop table unrelated_default_acl_probe');
      assert.deepEqual(await applyGroupPoints(client, historical.marketId), {
        ok: true,
        eligible: false,
        duplicate: false,
        reason: 'pre_activation',
        group_id: historical.groupId,
        scored_count: 0,
        winner_count: 0,
      });
      assert.deepEqual(await pointState(client), { events: [], stats: [], markers: [] });

      const beforeFutureGroup = await client.query<{ readonly micros: string }>(
        "select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as micros",
      );
      const futureGroup = await client.query<{ readonly pointsStartedAtMicros: string }>(`
        insert into groups (id, title, slug)
        values (-10009, 'future group', 'future-group-10009')
        returning (extract(epoch from points_started_at) * 1000000)::bigint::text as "pointsStartedAtMicros"
      `);
      const afterFutureGroup = await client.query<{ readonly micros: string }>(
        "select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as micros",
      );
      const beforeFutureMicros = beforeFutureGroup.rows[0]?.micros;
      const futureMicros = futureGroup.rows[0]?.pointsStartedAtMicros;
      const afterFutureMicros = afterFutureGroup.rows[0]?.micros;
      assert.ok(beforeFutureMicros);
      assert.ok(futureMicros);
      assert.ok(afterFutureMicros);
      assert.ok(BigInt(futureMicros) >= BigInt(beforeFutureMicros));
      assert.ok(BigInt(futureMicros) <= BigInt(afterFutureMicros));
    });
  });
}
