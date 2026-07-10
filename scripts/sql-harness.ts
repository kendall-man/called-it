import { join } from 'node:path';
import {
  createDisposableDatabase,
  discoverMigrationFiles,
  runSqlHarness,
} from './sql-harness/runner.js';
import {
  connectionStringForDatabase,
  dropCreatedRoles,
  ensureRequiredRoles,
  withPgClient,
  type RequiredRole,
} from './sql-harness/postgres.js';
import { validateCalledItSchema } from './sql-harness/schema-checks.js';

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, 'packages/db/migrations');

export async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('DATABASE_URL or POSTGRES_URL is required for real PostgreSQL SQL tests');
  }

  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  const databaseName = createDisposableDatabase();
  const createdRoles: RequiredRole[] = [];
  await withPgClient(connectionString, async (admin) => {
    createdRoles.push(...(await ensureRequiredRoles(admin)));
    try {
      await runSqlHarness({
        admin,
        migrationFiles: migrations,
        databaseName,
        prepareDatabase: async (disposableDatabase) => {
          const disposableUrl = connectionStringForDatabase(connectionString, disposableDatabase);
          await withPgClient(disposableUrl, async (client) => {
            await client.query('create publication supabase_realtime');
          });
        },
        applyMigration: async (migration, disposableDatabase) => {
          const disposableUrl = connectionStringForDatabase(connectionString, disposableDatabase);
          await withPgClient(disposableUrl, async (client) => {
            await client.query(migration.sql);
          });
        },
        validateSchema: async (disposableDatabase) => {
          const disposableUrl = connectionStringForDatabase(connectionString, disposableDatabase);
          await withPgClient(disposableUrl, validateCalledItSchema);
        },
      });
    } finally {
      await dropCreatedRoles(admin, createdRoles);
    }
  });

  console.log(`SQL harness applied ${migrations.length} migrations to ${databaseName} and cleaned it up`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
