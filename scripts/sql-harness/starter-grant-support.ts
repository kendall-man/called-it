import assert from 'node:assert/strict';
import { Pool, type Client } from 'pg';
import type { WagerStakeErrorCode, WagerStakeResult } from '../../packages/db/src/wager-types.js';
import {
  connectionStringForDatabase,
  postgresRoleOperations,
  withPgClient,
  withRequiredRoles,
} from './postgres.js';
import { runSqlHarness, createDisposableDatabase, type MigrationFile } from './runner.js';
import { validateCalledItSchema } from './schema-checks.js';

export const STARTER = 10_000_000;
export type RpcCode = WagerStakeErrorCode;
export type RpcResult = WagerStakeResult;
export type Fixture = { readonly userId: number; readonly groupId: number; readonly marketId: string };
export type Counts = { readonly positions: number; readonly ledger: number; readonly grants: number; readonly budgetCount: number; readonly budgetAmount: string };
type DirectStakeState = 'pending' | 'active' | 'void' | 'closed';
type DirectStakeInput = { readonly key: string; readonly allowStarter: boolean; readonly state: DirectStakeState };

type PositionSnapshot = { readonly id: string; readonly userId: string; readonly marketId: string; readonly side: string; readonly stake: string; readonly state: string; readonly placedAtMs: string };
type LedgerSnapshot = { readonly id: string; readonly userId: string; readonly groupId: string | null; readonly marketId: string | null; readonly kind: string; readonly lamports: string; readonly idempotencyKey: string };
type GrantSnapshot = { readonly userId: string; readonly ledgerEntryId: string; readonly positionId: string; readonly lamports: string; readonly idempotencyKey: string };
type BudgetSnapshot = { readonly enabled: boolean; readonly grantLamports: string; readonly totalCapLamports: string; readonly maxGrants: number; readonly grantedCount: number; readonly grantedLamports: string };
export type StateSnapshot = { readonly positions: PositionSnapshot[]; readonly ledger: LedgerSnapshot[]; readonly grants: GrantSnapshot[]; readonly budget: BudgetSnapshot };

let fixtureOffset = 0;

export async function withMigratedDb(
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
        prepareDatabase: async (db) => withDisposable(connectionString, db, async (client) => {
          await client.query('create publication supabase_realtime');
        }),
        applyMigration: async (migration, db) => withDisposable(connectionString, db, async (client) => {
          await client.query(migration.sql);
        }),
        validateSchema: async (db) => withDisposable(connectionString, db, async (client) => {
          await run(client, connectionStringForDatabase(connectionString, db));
          await validateCalledItSchema(client);
        }),
      });
    });
  });
}

export async function seedMarket(client: Client, input: { readonly userId: number; readonly groupId: number }): Promise<Fixture> {
  const marketId = `00000000-0000-4000-8000-${String(input.userId).padStart(12, '0')}`;
  await client.query('insert into groups (id, title, slug) values ($1, $2, $3)', [input.groupId, 'g', `g${Math.abs(input.groupId)}`]);
  await client.query('insert into users (id, display_name) values ($1, $2), ($3, $4)', [input.userId, 'u', input.userId + 100_000, 'c']);
  await client.query('insert into fixtures (fixture_id) values ($1)', [input.userId]);
  const claim = await client.query<{ readonly id: string }>('insert into claims (group_id, claimer_user_id, tg_message_id, quoted_text) values ($1, $2, $3, $4) returning id', [input.groupId, input.userId + 100_000, input.userId, 'claim']);
  await client.query('insert into markets (id, claim_id, group_id, fixture_id, spec, price_provenance, quote_probability, quote_multiplier, currency) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [marketId, claim.rows[0]?.id, input.groupId, input.userId, '{}', 'modelled', 0.5, 2, 'sol']);
  await client.query('insert into wager_groups (group_id, enabled, enabled_by) values ($1, true, $2)', [input.groupId, input.userId]);
  return { userId: input.userId, groupId: input.groupId, marketId };
}

export async function enableStarterBudget(client: Client): Promise<void> {
  await client.query('update wager_starter_budget set enabled = true where id = 1');
}

export async function seedLinkedWallet(client: Client, fixture: Fixture, pubkey = `Pubkey${fixture.userId}`): Promise<{ readonly linkHistoryId: number; readonly pubkey: string }> {
  const history = await client.query<{ id: number }>(
    'insert into wager_wallet_link_history (user_id, pubkey, verified_at) values ($1, $2, now()) returning id',
    [fixture.userId, pubkey],
  );
  const linkHistoryId = history.rows[0]?.id;
  assert.ok(linkHistoryId !== undefined);
  await client.query(
    'insert into wager_wallet_links (user_id, pubkey, verified_at, link_history_id) values ($1, $2, now(), $3)',
    [fixture.userId, pubkey, linkHistoryId],
  );
  return { linkHistoryId, pubkey };
}

export async function fundLinkedUser(client: Client, fixture: Fixture, lamports = 200_000_000): Promise<void> {
  await enableStarterBudget(client);
  await seedLinkedWallet(client, fixture);
  await client.query('insert into wager_ledger_entries (user_id, kind, lamports, idempotency_key) values ($1, $2, $3, $4)', [fixture.userId, 'deposit', lamports, `deposit:${fixture.userId}`]);
}

export async function stake(client: Client, fixture: Fixture, key: string, allowStarter: boolean): Promise<RpcResult> {
  return stakeWithInput(client, fixture, { key, allowStarter, state: 'active' });
}

async function stakeWithInput(client: Client, fixture: Fixture, input: DirectStakeInput): Promise<RpcResult> {
  const result = await client.query<{ readonly result: RpcResult }>('select wager_stake($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result', [fixture.userId, fixture.groupId, fixture.marketId, 'back', STARTER, 2, input.state, 1_751_630_000_000, input.key, input.allowStarter]);
  const row = result.rows[0];
  assert.ok(row);
  return row.result;
}

export async function poolStake(pool: Pool, fixture: Fixture, key: string): Promise<RpcResult> {
  const result = await pool.query<{ readonly result: RpcResult }>('select wager_stake($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result', [fixture.userId, fixture.groupId, fixture.marketId, 'back', STARTER, 2, 'active', 1_751_630_000_000, key, true]);
  const row = result.rows[0];
  assert.ok(row);
  return row.result;
}

export async function counts(client: Client, fixture: Fixture): Promise<Counts> {
  const result = await client.query<Counts>(`select
    (select count(*)::int from positions where user_id = $1 and market_id = $2) as positions,
    (select count(*)::int from wager_ledger_entries where user_id = $1 and market_id = $2) as ledger,
    (select count(*)::int from wager_starter_grants where user_id = $1) as grants,
    (select granted_count::int from wager_starter_budget where id = 1) as "budgetCount",
    (select granted_lamports::text from wager_starter_budget where id = 1) as "budgetAmount"`, [fixture.userId, fixture.marketId]);
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

export async function stateSnapshot(client: Client, fixture: Fixture): Promise<StateSnapshot> {
  const [positions, ledger, grants, budget] = await Promise.all([
    client.query<PositionSnapshot>('select id, user_id::text as "userId", market_id as "marketId", side, stake::text, state, placed_at_ms::text as "placedAtMs" from positions where user_id = $1 and market_id = $2 order by id', [fixture.userId, fixture.marketId]),
    client.query<LedgerSnapshot>('select id::text, user_id::text as "userId", group_id::text as "groupId", market_id as "marketId", kind, lamports::text, idempotency_key as "idempotencyKey" from wager_ledger_entries where user_id = $1 and (market_id = $2 or market_id is null) order by id', [fixture.userId, fixture.marketId]),
    client.query<GrantSnapshot>('select user_id::text as "userId", ledger_entry_id::text as "ledgerEntryId", position_id as "positionId", lamports::text, idempotency_key as "idempotencyKey" from wager_starter_grants where user_id = $1 order by user_id', [fixture.userId]),
    client.query<BudgetSnapshot>('select enabled, grant_lamports::text as "grantLamports", total_cap_lamports::text as "totalCapLamports", max_grants as "maxGrants", granted_count as "grantedCount", granted_lamports::text as "grantedLamports" from wager_starter_budget where id = 1'),
  ]);
  const budgetRow = budget.rows[0];
  assert.ok(budgetRow);
  return { positions: positions.rows, ledger: ledger.rows, grants: grants.rows, budget: budgetRow };
}

export async function assertHappyState(client: Client, fixture: Fixture, positionId: string, key: string, budgetCount: number): Promise<void> {
  const snapshot = await stateSnapshot(client, fixture);
  assert.deepEqual(snapshot.positions, [{ id: positionId, userId: String(fixture.userId), marketId: fixture.marketId, side: 'back', stake: String(STARTER), state: 'active', placedAtMs: '1751630000000' }]);
  const credit = snapshot.ledger[0];
  const debit = snapshot.ledger[1];
  assert.ok(credit);
  assert.ok(debit);
  assert.deepEqual(credit, { id: credit.id, userId: String(fixture.userId), groupId: String(fixture.groupId), marketId: fixture.marketId, kind: 'starter_grant', lamports: String(STARTER), idempotencyKey: `wager:starter:${fixture.userId}` });
  assert.deepEqual(debit, { id: debit.id, userId: String(fixture.userId), groupId: String(fixture.groupId), marketId: fixture.marketId, kind: 'stake', lamports: String(-STARTER), idempotencyKey: `wager:stake:api:${key}` });
  assert.deepEqual(snapshot.grants, [{ userId: String(fixture.userId), ledgerEntryId: credit.id, positionId, lamports: String(STARTER), idempotencyKey: `wager:starter:${fixture.userId}` }]);
  assert.deepEqual(snapshot.budget, { enabled: true, grantLamports: String(STARTER), totalCapLamports: '5000000000', maxGrants: 500, grantedCount: budgetCount, grantedLamports: String(budgetCount * STARTER) });
}

export async function assertBudgetParity(client: Client): Promise<void> {
  const result = await client.query<{ readonly budgetCount: number; readonly budgetAmount: string; readonly grantCount: number; readonly grantAmount: string; readonly stakeAmount: string }>(`select
    b.granted_count as "budgetCount", b.granted_lamports::text as "budgetAmount",
    (select count(*)::int from wager_starter_grants) as "grantCount",
    (select coalesce(sum(lamports), 0)::text from wager_ledger_entries where kind = 'starter_grant') as "grantAmount",
    (select coalesce(sum(lamports), 0)::text from wager_ledger_entries where kind = 'stake') as "stakeAmount"
    from wager_starter_budget b where b.id = 1`);
  const row = result.rows[0];
  assert.ok(row);
  assert.equal(row.grantCount, row.budgetCount);
  assert.equal(row.grantAmount, row.budgetAmount);
  assert.equal(BigInt(row.stakeAmount), -BigInt(row.grantAmount));
}

export async function assertNoWriteCode(client: Client, scenario: { readonly code: RpcCode; readonly mutate: (client: Client, fixture: Fixture) => Promise<void>; readonly allowStarter?: boolean }): Promise<void> {
  fixtureOffset += 1;
  const fixture = await seedMarket(client, { userId: 7200 + fixtureOffset, groupId: -7200 - fixtureOffset });
  await scenario.mutate(client, fixture);
  const before = await stateSnapshot(client, fixture);
  assert.deepEqual(await stake(client, fixture, `no-write-${fixtureOffset}`, scenario.allowStarter ?? true), { ok: false, code: scenario.code });
  assert.deepEqual(await stateSnapshot(client, fixture), before);
  await client.query('update wager_status set paused = false, reason = null where id = 1');
}

export async function assertNoWriteStateCode(client: Client, state: DirectStakeState): Promise<void> {
  fixtureOffset += 1;
  const fixture = await seedMarket(client, { userId: 7200 + fixtureOffset, groupId: -7200 - fixtureOffset });
  await enableStarterBudget(client);
  const before = await stateSnapshot(client, fixture);
  assert.deepEqual(await stakeWithInput(client, fixture, { key: `bad-state-${fixtureOffset}`, allowStarter: true, state }), { ok: false, code: 'closed' });
  assert.deepEqual(await stateSnapshot(client, fixture), before);
}

export async function assertInjectedExceptionRollsBack(client: Client): Promise<void> {
  const fixture = await seedMarket(client, { userId: 7299, groupId: -7299 });
  await enableStarterBudget(client);
  const before = await stateSnapshot(client, fixture);
  await client.query("create function fail_starter_grant() returns trigger language plpgsql as $$ begin raise exception 'injected starter failure'; end; $$");
  await client.query('create trigger fail_starter_grant before insert on wager_starter_grants for each row execute function fail_starter_grant()');
  await assert.rejects(stake(client, fixture, 'boom', true), /injected starter failure/);
  await client.query('drop trigger fail_starter_grant on wager_starter_grants');
  await client.query('drop function fail_starter_grant()');
  assert.deepEqual(await stateSnapshot(client, fixture), before);
}

export async function assertPrivileges(client: Client, url: string): Promise<void> {
  const privileges = await client.query<{ readonly anon: boolean; readonly authenticated: boolean; readonly service: boolean }>(
    "select has_function_privilege('anon','wager_stake(bigint,bigint,uuid,text,bigint,double precision,text,bigint,text,boolean)','execute') as anon, has_function_privilege('authenticated','wager_stake(bigint,bigint,uuid,text,bigint,double precision,text,bigint,text,boolean)','execute') as authenticated, has_function_privilege('service_role','wager_stake(bigint,bigint,uuid,text,bigint,double precision,text,bigint,text,boolean)','execute') as service",
  );
  assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service: true });
  await assertRoleDenied(url, 'anon');
  await assertRoleDenied(url, 'authenticated');
  const fixture = await seedMarket(client, { userId: 7199, groupId: -7199 });
  await enableStarterBudget(client);
  await withPgClient(url, async (roleClient) => {
    await roleClient.query('set role service_role');
    assert.equal((await stake(roleClient, fixture, 'service-role', true)).ok, true);
  });
}

export async function assertRoleDenied(url: string, role: 'anon' | 'authenticated'): Promise<void> {
  await withPgClient(url, async (roleClient) => {
    await roleClient.query(`set role ${role}`);
    await assert.rejects(roleClient.query("select wager_stake(1,1,'00000000-0000-4000-8000-000000000001','back',10000000,2,'active',1,'deny',true)"), /permission denied/);
  });
}

async function withDisposable<T>(connectionString: string, databaseName: string, run: (client: Client) => Promise<T>): Promise<T> {
  return withPgClient(connectionStringForDatabase(connectionString, databaseName), run);
}

function requiredDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('DATABASE_URL or POSTGRES_URL is required for starter-grant SQL tests');
  }
  return connectionString;
}
