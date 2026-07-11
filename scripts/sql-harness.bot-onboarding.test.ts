import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDisposableDatabase,
  discoverMigrationFiles,
  runSqlHarness,
  type MigrationFile,
} from './sql-harness/runner.js';
import {
  connectionStringForDatabase,
  postgresRoleOperations,
  withPgClient,
  withRequiredRoles,
} from './sql-harness/postgres.js';

const MIGRATION_NAME = '0009_bot_onboarding.sql';
const MIGRATIONS_DIR = new URL('../packages/db/migrations', import.meta.url).pathname;
const DATABASE_URL = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

test('tracks the Task 14 bot onboarding migration after public product views', async () => {
  // Given the repository migration directory
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);

  // When the filenames are inspected in application order
  const names = migrations.map((migration) => migration.name);

  // Then the onboarding marker follows the public product surface
  assert.ok(names.includes(MIGRATION_NAME));
  assert.ok(names.indexOf('0008_public_product_views.sql') < names.indexOf(MIGRATION_NAME));
});

const databaseTest = DATABASE_URL === undefined || DATABASE_URL.trim() === '' ? test.skip : test;

databaseTest('records one private ready marker per group and onboarding version', async () => {
  // Given a fresh database with every tracked migration applied
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withBotOnboardingDatabase(migrations, async (client, url) => {
    await client.query("insert into groups (id, title, slug) values (-100123, 'Ready group', 'ready-group')");

    // When the same group readiness is claimed twice
    const first = await markerResult(client, -100123, 'calledit_v1');
    const duplicate = await markerResult(client, -100123, 'calledit_v1');

    // Then only the first claim owns the ready message decision
    assert.deepEqual(first, {
      ok: true,
      created: true,
      group_id: -100123,
      onboarding_version: 'calledit_v1',
    });
    assert.deepEqual(duplicate, {
      ok: true,
      created: false,
      group_id: -100123,
      onboarding_version: 'calledit_v1',
    });
    const markers = await client.query<{ readonly count: string }>(
      'select count(*)::text as count from bot_group_ready_markers where group_id = $1',
      [-100123],
    );
    assert.equal(markers.rows[0]?.count, '1');
    assert.deepEqual(await markerResult(client, -100123, 'stale_v0'), { ok: false, code: 'invalid_input' });
    assert.deepEqual(await markerResult(client, -100124, 'calledit_v1'), { ok: false, code: 'group_not_found' });

    await withPgClient(url, async (roleClient) => {
      await roleClient.query('set role anon');
      try {
        await assert.rejects(roleClient.query('select * from bot_group_ready_markers'), /permission denied|row-level security/);
        await assert.rejects(
          roleClient.query("select bot_mark_group_ready(-100123, 'calledit_v1')"),
          /permission denied/,
        );
      } finally {
        await roleClient.query('reset role');
      }
    });
  });
});

async function markerResult(
  client: { query<T>(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly T[] }> },
  groupId: number,
  onboardingVersion: string,
): Promise<unknown> {
  const result = await client.query<{ readonly result: unknown }>(
    'select bot_mark_group_ready($1, $2) as result',
    [groupId, onboardingVersion],
  );
  return result.rows[0]?.result;
}

async function withBotOnboardingDatabase(
  migrations: readonly MigrationFile[],
  run: (client: import('pg').Client, url: string) => Promise<void>,
): Promise<void> {
  const connectionString = DATABASE_URL;
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('DATABASE_URL or POSTGRES_URL is required for bot onboarding SQL tests');
  }
  const databaseName = createDisposableDatabase();
  await withPgClient(connectionString, async (admin) => {
    await withRequiredRoles(postgresRoleOperations(admin), async () => {
      await runSqlHarness({
        admin,
        migrationFiles: migrations,
        databaseName,
        prepareDatabase: async (database) => {
          await withPgClient(connectionStringForDatabase(connectionString, database), async (client) => {
            await client.query('create publication supabase_realtime');
          });
        },
        applyMigration: async (migration, database) => {
          await withPgClient(connectionStringForDatabase(connectionString, database), async (client) => {
            await client.query(migration.sql);
          });
        },
        validateSchema: async (database) => {
          const url = connectionStringForDatabase(connectionString, database);
          await withPgClient(url, async (client) => run(client, url));
        },
      });
    });
  });
}
