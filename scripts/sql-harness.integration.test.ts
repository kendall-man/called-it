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

test('0035 repairs the latest finalized market projection and rejects an older snapshot', async () => {
  const connectionString = requiredDatabaseUrl();
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  const repair = migrations.find(({ name }) =>
    name === '0035_escrow_reconciliation_projection_repair.sql');
  assert.ok(repair, 'missing 0035 reconciliation projection repair');
  const databaseName = createDisposableDatabase();

  await withPgClient(connectionString, async (admin) => {
    await runSqlHarness({
      admin,
      migrationFiles: [repair],
      databaseName,
      prepareDatabase: async (disposableDatabase) => {
        await withDisposableClient(connectionString, disposableDatabase, async (client) => {
          await client.query(`
            create table public.escrow_market_links (
              market_id uuid primary key,
              cluster text not null,
              program_id text not null,
              custody_mode text not null,
              chain_state text not null,
              event_epoch numeric(20, 0) not null,
              projection_stale boolean not null,
              updated_at timestamptz not null
            );
            create table public.escrow_reconciliation_checks (
              market_id uuid not null,
              checked_slot bigint not null,
              cluster text not null,
              program_id text not null,
              vault_balance_atomic numeric(20, 0) not null,
              liability_atomic numeric(20, 0) not null,
              drift_atomic numeric(21, 0) not null,
              position_account_count integer not null,
              status text not null,
              details jsonb not null,
              checked_at timestamptz not null,
              primary key (market_id, checked_slot)
            );
            create table public.escrow_reconciliation_state (
              market_id uuid primary key,
              checked_slot bigint not null,
              cluster text not null,
              program_id text not null,
              vault_balance_atomic numeric(20, 0) not null,
              liability_atomic numeric(20, 0) not null,
              drift_atomic numeric(21, 0) not null,
              position_account_count integer not null,
              status text not null,
              checked_at timestamptz not null
            );
            insert into public.escrow_market_links values (
              '123e4567-e89b-12d3-a456-426614174000', 'devnet', 'program-a',
              'escrow', 'open', 0, false, '2026-07-19T00:00:00Z'
            );
            insert into public.escrow_reconciliation_checks values (
              '123e4567-e89b-12d3-a456-426614174000', 20, 'devnet', 'program-a',
              10000000, 10000000, 0, 1, 'in_sync',
              '{"chainState":"frozen","eventEpoch":"1"}', '2026-07-19T00:01:00Z'
            );
            insert into public.escrow_reconciliation_state values (
              '123e4567-e89b-12d3-a456-426614174000', 20, 'devnet', 'program-a',
              10000000, 10000000, 0, 1, 'in_sync', '2026-07-19T00:01:00Z'
            );
            insert into public.escrow_market_links values (
              '123e4567-e89b-12d3-a456-426614174001', 'devnet', 'program-a',
              'escrow', 'settled', 2, false, '2026-07-19T00:03:00Z'
            );
            insert into public.escrow_reconciliation_checks values (
              '123e4567-e89b-12d3-a456-426614174001', 21, 'devnet', 'program-a',
              10000000, 10000000, 0, 1, 'in_sync',
              '{"chainState":"frozen","eventEpoch":"1"}', '2026-07-19T00:02:00Z'
            );
            insert into public.escrow_reconciliation_state values (
              '123e4567-e89b-12d3-a456-426614174001', 21, 'devnet', 'program-a',
              10000000, 10000000, 0, 1, 'in_sync', '2026-07-19T00:02:00Z'
            );
          `);
        });
      },
      applyMigration: async (migration, disposableDatabase) => {
        await withDisposableClient(connectionString, disposableDatabase, async (client) => {
          await client.query(migration.sql);
        });
      },
      validateSchema: async (disposableDatabase) => {
        await withDisposableClient(connectionString, disposableDatabase, async (client) => {
          const repaired = await client.query<{ chain_state: string; event_epoch: string }>(`
            select chain_state, event_epoch::text
            from public.escrow_market_links
            where market_id = '123e4567-e89b-12d3-a456-426614174000'
          `);
          assert.deepEqual(repaired.rows[0], { chain_state: 'frozen', event_epoch: '1' });
          const terminal = await client.query<{ chain_state: string; event_epoch: string }>(`
            select chain_state, event_epoch::text
            from public.escrow_market_links
            where market_id = '123e4567-e89b-12d3-a456-426614174001'
          `);
          assert.deepEqual(terminal.rows[0], { chain_state: 'settled', event_epoch: '2' });

          await client.query(`
            select public.escrow_record_reconciliation(
              '123e4567-e89b-12d3-a456-426614174000', 'devnet', 'program-a', 19,
              10000000, 10000000, 1, 'in_sync',
              '{"chainState":"open","eventEpoch":"0"}', '2026-07-19T00:02:00Z'
            )
          `);
          const afterOlder = await client.query<{ chain_state: string; event_epoch: string }>(`
            select chain_state, event_epoch::text
            from public.escrow_market_links
            where market_id = '123e4567-e89b-12d3-a456-426614174000'
          `);
          assert.deepEqual(afterOlder.rows[0], { chain_state: 'frozen', event_epoch: '1' });
        });
      },
    });
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
