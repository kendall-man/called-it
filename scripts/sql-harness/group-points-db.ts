import { join } from 'node:path';
import type { Client } from 'pg';
import {
  connectionStringForDatabase,
  postgresRoleOperations,
  withPgClient,
  withRequiredRoles,
} from './postgres.js';
import {
  createDisposableDatabase,
  discoverMigrationFiles,
  runSqlHarness,
  type MigrationFile,
} from './runner.js';

const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/migrations');

let migrationsPromise: Promise<readonly MigrationFile[]> | undefined;

export function groupPointsMigrations(): Promise<readonly MigrationFile[]> {
  migrationsPromise ??= discoverMigrationFiles(MIGRATIONS_DIR);
  return migrationsPromise;
}

export async function withFreshGroupPointsDb(
  run: (client: Client, connectionString: string) => Promise<void>,
): Promise<void> {
  await withGroupPointsDb(await groupPointsMigrations(), run);
}

export async function withGroupPointsDb(
  migrations: readonly MigrationFile[],
  run: (client: Client, connectionString: string) => Promise<void>,
): Promise<void> {
  const connectionString = requiredDatabaseUrl();
  const databaseName = createDisposableDatabase();

  await withPgClient(connectionString, async (admin) => {
    await withRequiredRoles(postgresRoleOperations(admin), async () => {
      await runSqlHarness({
        admin,
        migrationFiles: migrations,
        databaseName,
        prepareDatabase: async (database) => withDatabase(connectionString, database, async (client) => {
          await client.query('create publication supabase_realtime');
        }),
        applyMigration: async (migration, database) => withDatabase(
          connectionString,
          database,
          async (client) => client.query(migration.sql).then(() => undefined),
        ),
        validateSchema: async (database) => withDatabase(
          connectionString,
          database,
          async (client) => run(client, connectionStringForDatabase(connectionString, database)),
        ),
      });
    });
  });
}

async function withDatabase<T>(
  connectionString: string,
  databaseName: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  return withPgClient(connectionStringForDatabase(connectionString, databaseName), run);
}

function requiredDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('DATABASE_URL or POSTGRES_URL is required for group-points SQL tests');
  }
  return connectionString;
}
