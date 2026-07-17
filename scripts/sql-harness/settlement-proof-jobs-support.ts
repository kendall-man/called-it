import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Client, Pool } from 'pg';
import {
  connectionStringForDatabase,
  postgresRoleOperations,
  withPgClient,
  withRequiredRoles,
} from './postgres.js';
import { createDisposableDatabase, runSqlHarness, type MigrationFile } from './runner.js';

export const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/migrations');
export const SETTLEMENT_PROOF_MIGRATION_NAME = '0007_settlement_proof_jobs.sql';
export interface JobPolicy {
  readonly maxAttempts: number;
  readonly leaseMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export const DEFAULT_POLICY: JobPolicy = {
  maxAttempts: 8,
  leaseMs: 30_000,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
};

export type SettlementProofJobKind = 'settlement' | 'proof';
export type RpcResult = Readonly<Record<string, unknown>>;
export type LeasedJob = Readonly<{
  market_id: string;
  job_kind: SettlementProofJobKind;
  status: 'leased';
  attempts: number;
  lease_owner: string;
  lease_token: string;
  lease_expires_at: string;
}>;

export interface TerminalMarketFixture {
  readonly marketId: string;
  readonly userId: number;
  readonly groupId: number;
}

let nextFixture = 1;

export async function withMigratedSettlementProofDb(
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
        prepareDatabase: async (db) => withDisposableClient(connectionString, db, async (client) => {
          await client.query('create publication supabase_realtime');
        }),
        applyMigration: async (migration, db) => withDisposableClient(connectionString, db, async (client) => {
          await client.query(migration.sql);
        }),
        validateSchema: async (db) => withDisposableClient(
          connectionString,
          db,
          async (client) => run(client, connectionStringForDatabase(connectionString, db)),
        ),
      });
    });
  });
}

export async function seedTerminalSolMarket(
  client: Client,
  input: {
    readonly trustTier?: 'chain_proven' | 'oracle_resolved';
    readonly status?: 'open' | 'settled' | 'voided';
  } = {},
): Promise<TerminalMarketFixture> {
  const sequence = nextFixture;
  nextFixture += 1;
  const userId = 960_000 + sequence;
  const groupId = -960_000 - sequence;
  const marketId = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  const trustTier = input.trustTier ?? 'chain_proven';
  const status = input.status ?? 'open';

  await client.query('insert into groups (id, title, slug) values ($1, $2, $3)', [
    groupId,
    'terminal group',
    `terminal-${sequence}`,
  ]);
  await client.query('insert into users (id, display_name) values ($1, $2), ($3, $4)', [
    userId,
    'terminal user',
    userId + 100_000,
    'claimer',
  ]);
  await client.query('insert into fixtures (fixture_id) values ($1)', [userId]);
  const claim = await client.query<{ readonly id: string }>(
    `insert into claims (group_id, claimer_user_id, tg_message_id, quoted_text)
     values ($1, $2, $3, $4)
     returning id`,
    [groupId, userId + 100_000, userId, 'terminal claim'],
  );
  const claimId = claim.rows[0]?.id;
  assert.ok(claimId, 'missing seed claim id');
  await client.query(
    `insert into markets (
       id, claim_id, group_id, fixture_id, spec, status, price_provenance,
       quote_probability, quote_multiplier, currency
     ) values ($1, $2, $3, $4, $5::jsonb, $6, 'modelled', 0.5, 2, 'sol')`,
    [marketId, claimId, groupId, userId, JSON.stringify({ trustTier }), status],
  );
  return { marketId, userId, groupId };
}

export async function rpc(
  client: Client | Pool,
  invocation: string,
  args: readonly unknown[],
): Promise<RpcResult> {
  const result = await client.query<{ readonly result: RpcResult }>(
    `select ${invocation} as result`,
    [...args],
  );
  const row = result.rows[0];
  assert.ok(row, `missing ${invocation} result`);
  return row.result;
}

export async function recordTerminalSettlement(
  client: Client | Pool,
  marketId: string,
  nowIso: string,
  input: {
    readonly outcome?: 'claim_won' | 'claim_lost' | 'void';
    readonly tier?: 'chain_proven' | 'oracle_resolved';
    readonly policy?: JobPolicy;
  } = {},
): Promise<RpcResult> {
  const policy = input.policy ?? DEFAULT_POLICY;
  return rpc(
    client,
    'settlement_record_terminal($1,$2,$3,$4::bigint[],$5,$6,$7,$8,$9,$10)',
    [
      marketId,
      input.outcome ?? 'claim_won',
      10,
      [8, 9, 10],
      input.tier ?? 'chain_proven',
      nowIso,
      policy.maxAttempts,
      policy.leaseMs,
      policy.retryBaseMs,
      policy.retryMaxMs,
    ],
  );
}

export async function enqueueJob(
  client: Client | Pool,
  marketId: string,
  kind: SettlementProofJobKind,
  dueAtIso: string,
  nowIso: string,
  policy: JobPolicy = DEFAULT_POLICY,
): Promise<RpcResult> {
  return rpc(
    client,
    'settlement_proof_enqueue($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      marketId,
      kind,
      dueAtIso,
      nowIso,
      policy.maxAttempts,
      policy.leaseMs,
      policy.retryBaseMs,
      policy.retryMaxMs,
    ],
  );
}

export async function leaseJobs(
  client: Client | Pool,
  kind: SettlementProofJobKind,
  workerId: string,
  nowIso: string,
  limit = 1,
): Promise<readonly LeasedJob[]> {
  const result = await client.query<LeasedJob>(
    'select * from settlement_proof_lease($1,$2,$3,$4)',
    [kind, workerId, nowIso, limit],
  );
  return result.rows;
}

export async function recordProofState(
  client: Client | Pool,
  marketId: string,
  status: 'pending' | 'verified' | 'failed' | 'unavailable',
  nowIso: string,
): Promise<RpcResult> {
  const verified = status === 'verified';
  return rpc(
    client,
    'proof_record_state($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)',
    [
      marketId,
      'stat',
      1,
      10,
      JSON.stringify({ nodes: ['proof'] }),
      verified ? 'validation-transaction' : null,
      verified ? 'https://explorer.example/validation-transaction' : null,
      status,
      nowIso,
    ],
  );
}

export async function insertWagerMarker(client: Client, marketId: string, nowIso: string): Promise<void> {
  await client.query(
    'insert into wager_settlements_applied (market_id, applied_at) values ($1, $2)',
    [marketId, nowIso],
  );
}

export async function markSettlementPosted(
  client: Client | Pool,
  marketId: string,
  nowIso: string,
): Promise<RpcResult> {
  return rpc(client, 'settlement_mark_posted($1,$2)', [marketId, nowIso]);
}

export async function completeJob(
  client: Client | Pool,
  marketId: string,
  kind: SettlementProofJobKind,
  workerId: string,
  leaseToken: string,
  nowIso: string,
): Promise<RpcResult> {
  return rpc(client, 'settlement_proof_complete($1,$2,$3,$4,$5)', [
    marketId,
    kind,
    workerId,
    leaseToken,
    nowIso,
  ]);
}

export async function retryJob(
  client: Client | Pool,
  marketId: string,
  kind: SettlementProofJobKind,
  workerId: string,
  leaseToken: string,
  errorCode: string,
  delayMs: number,
  nowIso: string,
): Promise<RpcResult> {
  return rpc(client, 'settlement_proof_retry($1,$2,$3,$4,$5,$6,$7)', [
    marketId,
    kind,
    workerId,
    leaseToken,
    errorCode,
    delayMs,
    nowIso,
  ]);
}

export async function deadLetterJob(
  client: Client | Pool,
  marketId: string,
  kind: SettlementProofJobKind,
  workerId: string,
  leaseToken: string,
  errorCode: string,
  nowIso: string,
): Promise<RpcResult> {
  return rpc(client, 'settlement_proof_dead_letter($1,$2,$3,$4,$5,$6)', [
    marketId,
    kind,
    workerId,
    leaseToken,
    errorCode,
    nowIso,
  ]);
}

export async function terminalGaps(client: Client | Pool, limit: number): Promise<readonly RpcResult[]> {
  const result = await client.query<{ readonly row: RpcResult }>(
    'select to_jsonb(g) as row from settlement_terminal_gaps($1) g',
    [limit],
  );
  return result.rows.map((row) => row.row);
}

export async function reconcileTerminalJobs(
  client: Client | Pool,
  nowIso: string,
  limit: number,
  policy: JobPolicy = DEFAULT_POLICY,
  initialChainProofDelayMs = 60_000,
): Promise<readonly RpcResult[]> {
  const result = await client.query<{ readonly row: RpcResult }>(
    `select to_jsonb(r) as row
     from settlement_reconcile_terminal_jobs($1,$2,$3,$4,$5,$6,$7) r`,
    [
      nowIso,
      limit,
      policy.maxAttempts,
      policy.leaseMs,
      policy.retryBaseMs,
      policy.retryMaxMs,
      initialChainProofDelayMs,
    ],
  );
  return result.rows.map((row) => row.row);
}

export async function backlog(
  client: Client | Pool,
  kind: SettlementProofJobKind,
  nowIso: string,
): Promise<RpcResult> {
  const result = await client.query<{ readonly row: RpcResult }>(
    'select to_jsonb(b) as row from settlement_proof_backlog($1,$2) b',
    [kind, nowIso],
  );
  const row = result.rows[0];
  assert.ok(row, 'missing settlement proof backlog row');
  return row.row;
}

export async function jobSnapshot(
  client: Client | Pool,
  marketId: string,
  kind: SettlementProofJobKind,
): Promise<Readonly<Record<string, unknown>>> {
  const result = await client.query<{ readonly row: Readonly<Record<string, unknown>> }>(
    `select to_jsonb(j) as row
     from settlement_proof_jobs j
     where market_id = $1 and job_kind = $2`,
    [marketId, kind],
  );
  const row = result.rows[0];
  assert.ok(row, `missing ${kind} job`);
  return row.row;
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
    throw new Error('DATABASE_URL or POSTGRES_URL is required for settlement proof SQL tests');
  }
  return connectionString;
}
