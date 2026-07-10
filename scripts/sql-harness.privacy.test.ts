import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import type { Client } from 'pg';
import {
  connectionStringForDatabase,
  postgresRoleOperations,
  withPgClient,
  withRequiredRoles,
} from './sql-harness/postgres.js';
import { createDisposableDatabase, discoverMigrationFiles, runSqlHarness, type MigrationFile } from './sql-harness/runner.js';

const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/migrations');
const PRIVATE_SENTINELS = [
  '@calledit_private_user',
  '7YWHMfk9JZe0LM0g1ZauHuiSxhI5g4hUuS1W7MwFX5Bh',
  'https://private.example/claim',
  'private@example.test',
  '+14155550199',
  'PRIVATE CLAIM: striker scores before halftime',
] as const;

const RECEIPT_COLUMNS = [
  'back_pot_lamports',
  'claimer_alias',
  'created_at',
  'currency',
  'deciding_seq',
  'doubt_pot_lamports',
  'evidence_seqs',
  'explorer_url',
  'group_slug',
  'market_id',
  'matched_amount_lamports',
  'merkle_proof',
  'outcome',
  'paid_amount_lamports',
  'position_count',
  'price_provenance',
  'proof_seq',
  'proof_status',
  'quote_multiplier',
  'quote_probability',
  'refunded_amount_lamports',
  'settled_at',
  'spec',
  'stat_key',
  'status',
  'tier',
  'validate_stat_tx',
] as const;

const BOARD_COLUMNS = [
  'back_pot_lamports',
  'created_at',
  'currency',
  'doubt_pot_lamports',
  'group_slug',
  'market_id',
  'matched_amount_lamports',
  'outcome',
  'paid_amount_lamports',
  'position_count',
  'price_provenance',
  'quote_multiplier',
  'quote_probability',
  'refunded_amount_lamports',
  'settled_at',
  'spec',
  'status',
] as const;

test('privacy-safe public SOL migration applies fresh and as a 0001-0007 upgrade', async () => {
  const migrations = await requiredMigrations();

  await withPrivacyDatabase(migrations, async () => undefined);
  await withPrivacyDatabase(migrations, async () => undefined, assertUpgradeBoundary);
});

test('public product views retain only aliases, deterministic specs, and aggregate SOL facts', async () => {
  const migrations = await requiredMigrations();
  await withPrivacyDatabase(migrations, async (client, url) => {
    await seedPrivacyFixtures(client);
    await assertViewColumns(client, 'public_receipts', RECEIPT_COLUMNS);
    await assertViewColumns(client, 'public_group_board', BOARD_COLUMNS);
    await assertPublicViewsArePrivateSentinelFree(client);
    await assertReplayMarketsAreExcluded(client);
    await assertPublicReceiptChoosesOneBestProof(client);
    await assertAliasContract(client);
    await assertPublicAccessContract(client, url);
    await assertRealtimePublication(client);
    await assertOnboardingRetention(client);
  });
});

async function requiredMigrations(): Promise<readonly MigrationFile[]> {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  for (const name of ['0007_settlement_proof_jobs.sql', '0008_public_product_views.sql']) {
    assert.ok(migrations.some((migration) => migration.name === name), `missing ${name}`);
  }
  return migrations;
}

async function withPrivacyDatabase(
  migrations: readonly MigrationFile[],
  run: (client: Client, url: string) => Promise<void>,
  beforeTaskEleven?: (client: Client) => Promise<void>,
): Promise<void> {
  const connectionString = requiredDatabaseUrl();
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
            if (migration.name === '0008_public_product_views.sql') {
              await beforeTaskEleven?.(client);
            }
            await client.query(migration.sql);
          });
        },
        validateSchema: async (database) => {
          await withPgClient(connectionStringForDatabase(connectionString, database), async (client) => {
            await run(client, connectionStringForDatabase(connectionString, database));
          });
        },
      });
    });
  });
}

async function assertUpgradeBoundary(client: Client): Promise<void> {
  const tables = await client.query<{ readonly exists: boolean }>(
    "select to_regclass('public.settlement_proof_jobs') is not null as exists",
  );
  assert.equal(tables.rows[0]?.exists, true);
  const alias = await client.query<{ readonly exists: boolean }>(
    "select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'memberships' and column_name = 'public_alias') as exists",
  );
  assert.equal(alias.rows[0]?.exists, false);
}

async function seedPrivacyFixtures(client: Client): Promise<void> {
  await client.query(
    'insert into groups (id, title, slug, web_enabled) values (101, $1, $2, true), (102, $3, $4, false)',
    [PRIVATE_SENTINELS[0], 'privacy-public', PRIVATE_SENTINELS[0], 'privacy-private'],
  );
  await client.query(
    'insert into users (id, display_name, username) values (201, $1, $2), (202, $3, $4), (203, $5, $6)',
    [PRIVATE_SENTINELS[0], PRIVATE_SENTINELS[0], PRIVATE_SENTINELS[3], PRIVATE_SENTINELS[0], PRIVATE_SENTINELS[4], PRIVATE_SENTINELS[0]],
  );
  await client.query('insert into memberships (group_id, user_id) values (101, 201), (101, 202), (102, 203)');
  await client.query('insert into fixtures (fixture_id) values (301), (302)');
  await client.query(
    'insert into claims (id, group_id, claimer_user_id, tg_message_id, quoted_text) values ($1, 101, 201, 1, $2), ($3, 102, 203, 2, $4)',
    [
      '00000000-0000-4000-8000-000000000301',
      PRIVATE_SENTINELS.join(' '),
      '00000000-0000-4000-8000-000000000302',
      PRIVATE_SENTINELS.join(' '),
    ],
  );
  await client.query(
    "insert into markets (id, claim_id, group_id, fixture_id, spec, price_provenance, quote_probability, quote_multiplier, currency) values ($1, $2, 101, 301, '{\"claimType\":\"totals_ou\",\"line\":2.5}'::jsonb, 'market', 0.5, 2, 'sol'), ($3, $4, 102, 302, '{\"claimType\":\"totals_ou\",\"line\":2.5}'::jsonb, 'market', 0.5, 2, 'sol')",
    [
      '00000000-0000-4000-8000-000000000401',
      '00000000-0000-4000-8000-000000000301',
      '00000000-0000-4000-8000-000000000402',
      '00000000-0000-4000-8000-000000000302',
    ],
  );
  await client.query(
    "insert into positions (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms) values ('00000000-0000-4000-8000-000000000401', 201, 'back', 60000000, 2, 'active', 1), ('00000000-0000-4000-8000-000000000401', 202, 'doubt', 40000000, 2, 'active', 1)",
  );
  await client.query(
    "insert into wager_ledger_entries (user_id, group_id, market_id, kind, lamports, idempotency_key) values (201, 101, '00000000-0000-4000-8000-000000000401', 'payout', 80000000, 'privacy-payout'), (202, 101, '00000000-0000-4000-8000-000000000401', 'refund', 20000000, 'privacy-refund')",
  );
  await client.query(
    "insert into settlements (market_id, outcome, tier) values ('00000000-0000-4000-8000-000000000401', 'claim_won', 'chain_proven'), ('00000000-0000-4000-8000-000000000402', 'void', 'oracle_resolved')",
  );
  await client.query(
    "insert into proofs (market_id, kind, status) values ('00000000-0000-4000-8000-000000000401', 'stat', 'pending')",
  );
  await client.query(
    "insert into proofs (market_id, kind, status, merkle_proof, validate_stat_tx, explorer_url, verified_at) values ('00000000-0000-4000-8000-000000000401', 'odds', 'verified', '{\"proof\":\"verified\"}'::jsonb, 'verified-tx', 'https://explorer.example/verified-tx', now())",
  );
  await client.query(
    "insert into claims (id, group_id, claimer_user_id, tg_message_id, quoted_text) values ('00000000-0000-4000-8000-000000000303', 101, 201, 3, 'replay claim')",
  );
  await client.query(
    "insert into markets (id, claim_id, group_id, fixture_id, spec, price_provenance, quote_probability, quote_multiplier, currency, is_replay) values ('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000303', 101, 301, '{\"claimType\":\"totals_ou\",\"line\":2.5}'::jsonb, 'market', 0.5, 2, 'sol', true)",
  );
  await client.query(
    "insert into feed_events (fixture_id, seq, ts_ms, received_at_ms, kind, payload) values (301, 1, 1, 1, 'goal', '{\"minute\":10,\"detail\":{\"playerName\":\"Safe Player\",\"goalType\":\"open_play\"},\"private\":\"PRIVATE CLAIM: striker scores before halftime\"}'::jsonb)",
  );
  await client.query(
    "insert into onboarding_events (idempotency_key, session_id, event_name, actor_pseudonym, group_pseudonym, role_code, source_code) values ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000502', 'group_ready', repeat('a', 43), repeat('b', 43), 'member', 'telegram')",
  );
}

async function assertReplayMarketsAreExcluded(client: Client): Promise<void> {
  const views = ['public_receipts', 'public_group_board'] as const;
  for (const view of views) {
    const replay = await client.query<{ readonly count: string }>(
      `select count(*)::text as count from ${view} where market_id = '00000000-0000-4000-8000-000000000403'`,
    );
    assert.equal(replay.rows[0]?.count, '0');
  }
}

async function assertPublicReceiptChoosesOneBestProof(client: Client): Promise<void> {
  const receipt = await client.query<{
    readonly count: string;
    readonly proofStatus: string | null;
    readonly validateStatTx: string | null;
    readonly backPotLamports: string;
    readonly paidAmountLamports: string;
    readonly lamportType: string;
  }>(`
    select
      count(*) over ()::text as count,
      proof_status as "proofStatus",
      validate_stat_tx as "validateStatTx",
      back_pot_lamports as "backPotLamports",
      paid_amount_lamports as "paidAmountLamports",
      pg_typeof(back_pot_lamports)::text as "lamportType"
    from public_receipts
    where market_id = '00000000-0000-4000-8000-000000000401'
  `);
  assert.equal(receipt.rows.length, 1);
  assert.deepEqual(receipt.rows[0], {
    count: '1',
    proofStatus: 'verified',
    validateStatTx: 'verified-tx',
    backPotLamports: '60000000',
    paidAmountLamports: '80000000',
    lamportType: 'text',
  });
}

async function assertViewColumns(
  client: Client,
  view: string,
  expected: readonly string[],
): Promise<void> {
  const result = await client.query<{ readonly column_name: string }>(
    'select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by column_name',
    ['public', view],
  );
  assert.deepEqual(result.rows.map((row) => row.column_name), [...expected].sort());
}

async function assertPublicViewsArePrivateSentinelFree(client: Client): Promise<void> {
  const views = ['public_receipts', 'public_group_board', 'public_evidence'] as const;
  for (const view of views) {
    const result = await client.query<{ readonly payload: string }>(`select coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb)::text as payload from ${view} v`);
    const payload = result.rows[0]?.payload ?? '';
    for (const sentinel of PRIVATE_SENTINELS) assert.equal(payload.includes(sentinel), false, `${view} leaked ${sentinel}`);
  }

  const privateRows = await client.query<{ readonly count: string }>(
    "select count(*)::text as count from public_receipts where group_slug = 'privacy-private'",
  );
  assert.equal(privateRows.rows[0]?.count, '0');
  const events = await client.query<{ readonly payload: string }>(
    "select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb)::text as payload from onboarding_events e",
  );
  for (const sentinel of PRIVATE_SENTINELS) assert.equal((events.rows[0]?.payload ?? '').includes(sentinel), false);
}

async function assertAliasContract(client: Client): Promise<void> {
  const aliases = await client.query<{ readonly public_alias: string }>(
    'select public_alias from memberships where group_id = 101 order by user_id',
  );
  assert.equal(aliases.rows.length, 2);
  assert.match(aliases.rows[0]?.public_alias ?? '', /^Player [A-F0-9]{8}$/);
  assert.notEqual(aliases.rows[0]?.public_alias, aliases.rows[1]?.public_alias);
  await assert.rejects(
    client.query("update memberships set public_alias = 'Player DEADBEEF' where group_id = 101 and user_id = 201"),
    /immutable/,
  );
  const constraints = await client.query<{ readonly exists: boolean }>(
    "select exists(select 1 from pg_constraint where conname = 'memberships_group_public_alias_key') as exists",
  );
  assert.equal(constraints.rows[0]?.exists, true);
}

async function assertPublicAccessContract(client: Client, url: string): Promise<void> {
  await withPgClient(url, async (roleClient) => {
    await roleClient.query('set role anon');
    const receipts = await roleClient.query<{ readonly count: string }>('select count(*)::text as count from public_receipts');
    assert.equal(receipts.rows[0]?.count, '1');
    const settlements = await roleClient.query<{ readonly count: string }>('select count(*)::text as count from settlements');
    assert.equal(settlements.rows[0]?.count, '1');
    await assert.rejects(roleClient.query('select * from groups'), /permission denied/);
    await assert.rejects(roleClient.query('select * from onboarding_events'), /permission denied/);
  });
}

async function assertRealtimePublication(client: Client): Promise<void> {
  const tables = await client.query<{ readonly table_name: string }>(
    "select tablename as table_name from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by tablename",
  );
  assert.deepEqual(tables.rows.map((row) => row.table_name), ['proofs', 'settlements']);
}

async function assertOnboardingRetention(client: Client): Promise<void> {
  await client.query(
    "insert into onboarding_events (idempotency_key, session_id, event_name, actor_pseudonym, group_pseudonym, role_code, source_code, created_at) values ('00000000-0000-4000-8000-000000000503', '00000000-0000-4000-8000-000000000504', 'receipt_opened', repeat('c', 43), repeat('d', 43), 'member', 'web', clock_timestamp() - interval '31 days')",
  );
  const pruned = await client.query<{ readonly result: { readonly ok: boolean; readonly count: number } }>('select prune_onboarding_events(10) as result');
  assert.deepEqual(pruned.rows[0]?.result, { ok: true, count: 1 });
}

function requiredDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('DATABASE_URL or POSTGRES_URL is required for SQL privacy tests');
  }
  return connectionString;
}
