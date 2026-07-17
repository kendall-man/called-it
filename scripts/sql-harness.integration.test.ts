import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  createDisposableDatabase,
  discoverMigrationFiles,
  runSqlHarness,
} from './sql-harness/runner.js';
import {
  connectionStringForDatabase,
  postgresRoleOperations,
  withPgClient,
  withRequiredRoles,
  type RoleOperations,
} from './sql-harness/postgres.js';
import { validateCalledItSchema } from './sql-harness/schema-checks.js';

const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/migrations');

test('detects missing realtime publication membership and cleans the database', async () => {
  // Given the tracked migrations applied to a disposable real PostgreSQL database
  // When one migrated table is removed from the realtime publication
  // Then schema validation rejects the missing member
  await assertPublicationMutationRejected(
    'alter publication supabase_realtime drop table proofs',
    /realtime publication.*missing public\.proofs/,
  );
});

test('detects unexpected realtime publication membership and cleans the database', async () => {
  // Given the tracked migrations applied to a disposable real PostgreSQL database
  // When an extra table is added to the realtime publication
  // Then schema validation rejects the unexpected member
  await assertPublicationMutationRejected(
    'alter publication supabase_realtime add table groups',
    /realtime publication.*unexpected public\.groups/,
  );
});

test('cleans real roles after partial setup failure and preserves pre-existing roles', async () => {
  // Given a real PostgreSQL cluster with one pre-existing required role
  const connectionString = requiredDatabaseUrl();
  await withPgClient(connectionString, async (admin) => {
    await admin.query('create role authenticated');
    const postgresOperations = postgresRoleOperations(admin);
    const failingOperations: RoleOperations = {
      roleExists: postgresOperations.roleExists,
      createRole: async (role) => {
        if (role === 'service_role') {
          throw new Error('injected PostgreSQL role creation failure');
        }
        await postgresOperations.createRole(role);
      },
      dropRole: postgresOperations.dropRole,
    };

    try {
      // When setup fails after creating the first missing role
      await assert.rejects(
        withRequiredRoles(failingOperations, async () => undefined),
        /injected PostgreSQL role creation failure/,
      );

      // Then the harness-created role is gone and the pre-existing role remains
      const result = await admin.query<{ rolname: string }>(
        `select rolname
         from pg_roles
         where rolname in ('anon', 'authenticated', 'service_role')
         order by rolname`,
      );
      assert.deepEqual(result.rows.map((row) => row.rolname), ['authenticated']);
    } finally {
      await admin.query('drop role if exists service_role, anon, authenticated');
    }
  });
});

async function assertPublicationMutationRejected(
  mutation: string,
  expectedError: RegExp,
): Promise<void> {
  const connectionString = requiredDatabaseUrl();
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  const databaseName = createDisposableDatabase();

  await withPgClient(connectionString, async (admin) => {
    await withRequiredRoles(postgresRoleOperations(admin), async () => {
      await assert.rejects(
        runSqlHarness({
          admin,
          migrationFiles: migrations,
          databaseName,
          prepareDatabase: async (disposableDatabase) => {
            await withDisposableClient(connectionString, disposableDatabase, async (client) => {
              await client.query('create publication supabase_realtime');
            });
          },
          applyMigration: async (migration, disposableDatabase) => {
            await withDisposableClient(connectionString, disposableDatabase, async (client) => {
              await client.query(migration.sql);
            });
          },
          validateSchema: async (disposableDatabase) => {
            await withDisposableClient(connectionString, disposableDatabase, async (client) => {
              await client.query(mutation);
              await validateCalledItSchema(client);
            });
          },
        }),
        expectedError,
      );

      const result = await admin.query<{ exists: boolean }>(
        'select exists(select 1 from pg_database where datname = $1) as exists',
        [databaseName],
      );
      assert.equal(result.rows[0]?.exists, false);
    });
  });
}

async function withDisposableClient<T>(
  connectionString: string,
  databaseName: string,
  run: Parameters<typeof withPgClient<T>>[1],
): Promise<T> {
  return withPgClient(connectionStringForDatabase(connectionString, databaseName), run);
}

function requiredDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('DATABASE_URL or POSTGRES_URL is required for SQL integration tests');
  }
  return connectionString;
}
