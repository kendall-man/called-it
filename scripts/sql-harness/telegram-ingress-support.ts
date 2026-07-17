import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Client } from 'pg';
import {
  connectionStringForDatabase,
  postgresRoleOperations,
  withPgClient,
  withRequiredRoles,
} from './postgres.js';
import { runSqlHarness, createDisposableDatabase, type MigrationFile } from './runner.js';
import { TELEGRAM_FUNCTIONS, TELEGRAM_FUNCTION_NAMES, TELEGRAM_TABLES } from './telegram-ingress-contract.js';

export const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/migrations');
export const TELEGRAM_MIGRATION_NAME = '0006_telegram_ingress.sql';

type RelationRow = {
  readonly relname: string;
};

type FunctionRow = {
  readonly signature: string;
};

type FunctionPrivilegeRow = {
  readonly signature: string;
  readonly anon_can_execute: boolean;
  readonly authenticated_can_execute: boolean;
  readonly service_role_can_execute: boolean;
};

type RpcRow<T> = {
  readonly result: T;
};

export type TelegramLeaseResult = {
  readonly items: readonly { readonly id: string }[];
};

export type TelegramPersistedUpdate = {
  readonly id: string;
  readonly routing_decision: string;
  readonly state: string;
  readonly duplicate: boolean;
};

export async function withMigratedTelegramDb(
  migrations: readonly MigrationFile[],
  run: (client: Client, url: string) => Promise<void>,
): Promise<void> {
  const connectionString = requiredDatabaseUrl();
  const databaseName = createDisposableDatabase();
  await withPgClient(connectionString, async (admin) => {
    await withRequiredRoles(postgresRoleOperations(admin), async () => {
      await runSqlHarness({
        admin,
        migrationFiles: migrations,
        databaseName,
        prepareDatabase: async (db) => {
          await withDisposableClient(connectionString, db, async (client) => {
            await client.query('create publication supabase_realtime');
          });
        },
        applyMigration: async (migration, db) => {
          await withDisposableClient(connectionString, db, async (client) => {
            await client.query(migration.sql);
          });
        },
        validateSchema: async (db) => {
          await withDisposableClient(connectionString, db, async (client) => {
            await run(client, connectionStringForDatabase(connectionString, db));
          });
        },
      });
    });
  });
}

export function telegramMigration(migrations: readonly MigrationFile[]): MigrationFile {
  const migration = migrations.find((entry) => entry.name === TELEGRAM_MIGRATION_NAME);
  assert.ok(migration, `missing ${TELEGRAM_MIGRATION_NAME}`);
  return migration;
}

export async function assertTelegramObjectsPresent(client: Client): Promise<void> {
  const relations = await client.query<RelationRow>(
    `select relname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any($1::text[])`,
    [TELEGRAM_TABLES],
  );
  const presentTables = new Set(relations.rows.map((row) => row.relname));
  assert.deepEqual([...presentTables].sort(), [...TELEGRAM_TABLES].sort());

  const functions = await client.query<FunctionRow>(
    `select p.oid::regprocedure::text as signature
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any($1::text[])`,
    [[...TELEGRAM_FUNCTION_NAMES]],
  );
  const presentFunctions = new Set(functions.rows.map((row) => row.signature));
  assert.deepEqual([...presentFunctions].sort(), [...TELEGRAM_FUNCTIONS].sort());

  const privileges = await client.query<FunctionPrivilegeRow>(
    `select
       p.oid::regprocedure::text as signature,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
       has_function_privilege('service_role', p.oid, 'execute') as service_role_can_execute
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any($1::text[])
     order by p.oid::regprocedure::text`,
    [[...TELEGRAM_FUNCTION_NAMES]],
  );
  assert.deepEqual(
    privileges.rows,
    [...TELEGRAM_FUNCTIONS].sort().map((signature) => ({
      signature,
      anon_can_execute: false,
      authenticated_can_execute: false,
      service_role_can_execute: true,
    })),
  );

  const policies = await client.query<{ readonly tablename: string }>(
    `select tablename
     from pg_policies
     where schemaname = 'public' and tablename = any($1::text[])`,
    [TELEGRAM_TABLES],
  );
  assert.deepEqual(policies.rows, []);
}

export async function telegramRpc<T extends Record<string, unknown>>(
  client: Client,
  invocation: string,
  args: readonly unknown[],
): Promise<T> {
  const result = await client.query<RpcRow<T>>(
    `select ${invocation} as result`,
    [...args],
  );
  const row = result.rows[0];
  assert.ok(row, `missing RPC result for ${invocation}`);
  return row.result;
}

export function telegramFingerprint(value: number): string {
  const suffix = value.toString(36).padStart(3, '0');
  assert.equal(suffix.length, 3, 'test fingerprint suffix overflowed');
  return `${'A'.repeat(40)}${suffix}`;
}

export async function persistTelegramUpdate(
  client: Client,
  updateId: number,
  sourceKey: string,
  routingDecision: 'pending_engine' | 'routed_concierge',
): Promise<TelegramPersistedUpdate> {
  return telegramRpc<TelegramPersistedUpdate>(
    client,
    'telegram_persist_update($1,$2,$3,$4,$5::jsonb,$6)',
    [
      sourceKey,
      telegramFingerprint(updateId),
      updateId,
      'message',
      JSON.stringify({ update_id: updateId, message: { message_id: updateId, chat: { id: -1001 } } }),
      routingDecision,
    ],
  );
}

async function withDisposableClient<T>(
  connectionString: string,
  databaseName: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  return withPgClient(connectionStringForDatabase(connectionString, databaseName), run);
}

function requiredDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('DATABASE_URL or POSTGRES_URL is required for telegram ingress SQL tests');
  }
  return connectionString;
}
