import assert from 'node:assert/strict';
import type { Client } from 'pg';
import { withPgClient } from './postgres.js';
import type { MigrationFile } from './runner.js';
import {
  stake,
  stateSnapshot,
  type Fixture,
  type RpcResult,
} from './starter-grant-support.js';

const STAKE_SIGNATURE = 'public.wager_stake(bigint,bigint,uuid,text,bigint,double precision,text,bigint,text,boolean)';
const STAKE_ARGUMENTS = [
  'p_user_id',
  'p_group_id',
  'p_market_id',
  'p_side',
  'p_lamports',
  'p_multiplier',
  'p_state',
  'p_placed_at_ms',
  'p_idempotency_key',
  'p_starter_only',
] as const;

type FunctionContractRow = {
  readonly argumentNames: readonly string[];
  readonly functionDefinition: string;
  readonly overloadCount: number;
  readonly securityDefiner: boolean;
  readonly settings: readonly string[] | null;
};

type RlsRow = {
  readonly policyCount: number;
  readonly rowSecurity: boolean;
  readonly tableName: string;
};

type LockWait = {
  readonly blockedPid: number;
  readonly blockerPid: number;
  readonly isSettled: () => boolean;
};

export async function applyStarterOnlyUpgrade(
  client: Client,
  migration: MigrationFile,
): Promise<void> {
  const priorContract = await client.query<{ readonly argumentNames: readonly string[] }>(`
    select proargnames as "argumentNames"
    from pg_proc
    where oid = 'public.wager_stake(bigint,bigint,uuid,text,bigint,double precision,text,bigint,text,boolean)'::regprocedure
  `);
  assert.equal(priorContract.rows[0]?.argumentNames.at(-1), 'p_allow_starter');
  await client.query(migration.sql);
  await assertStarterOnlySqlContract(client);
}

export async function assertStarterOnlySqlContract(client: Client): Promise<void> {
  const metadata = await client.query<FunctionContractRow>(`
    select
      p.proargnames as "argumentNames",
      pg_get_functiondef(p.oid) as "functionDefinition",
      (select count(*)::int from pg_proc candidate join pg_namespace namespace on namespace.oid = candidate.pronamespace where namespace.nspname = 'public' and candidate.proname = 'wager_stake') as "overloadCount",
      p.prosecdef as "securityDefiner",
      p.proconfig as settings
    from pg_proc p
    where p.oid = $1::regprocedure
  `, [STAKE_SIGNATURE]);
  const functionRow = metadata.rows[0];
  assert.ok(functionRow);
  assert.deepEqual(functionRow.argumentNames, STAKE_ARGUMENTS);
  assert.equal(functionRow.overloadCount, 1);
  assert.equal(functionRow.securityDefiner, true);
  assert.deepEqual(functionRow.settings, ['search_path=public']);
  assert.match(
    functionRow.functionDefinition,
    /from markets m\s+where m\.id = p_market_id\s+for update;/i,
  );
  assert.match(functionRow.functionDefinition, /if p_starter_only then/i);
  assert.doesNotMatch(functionRow.functionDefinition, /p_allow_starter/i);

  const legacyArities = await client.query<{ readonly eightArgAbsent: boolean; readonly nineArgAbsent: boolean }>(`
    select
      to_regprocedure('public.wager_stake(bigint,bigint,uuid,text,bigint,double precision,text,bigint)') is null as "eightArgAbsent",
      to_regprocedure('public.wager_stake(bigint,bigint,uuid,text,bigint,double precision,text,bigint,text)') is null as "nineArgAbsent"
  `);
  assert.deepEqual(legacyArities.rows[0], { eightArgAbsent: true, nineArgAbsent: true });
  await assert.rejects(
    client.query(`select public.wager_stake(
      p_user_id => 1,
      p_group_id => 1,
      p_market_id => '00000000-0000-4000-8000-000000000001',
      p_side => 'back',
      p_lamports => 10000000,
      p_multiplier => 2,
      p_state => 'active',
      p_placed_at_ms => 1,
      p_idempotency_key => 'legacy-name',
      p_allow_starter => true
    )`),
    /function public\.wager_stake\(.*\) does not exist/s,
  );
  await assert.rejects(
    client.query(`select public.wager_stake(
      1,
      1,
      '00000000-0000-4000-8000-000000000001',
      'back',
      10000000,
      2,
      'active',
      1,
      'null-capability',
      null
    )`),
    /wager_stake: p_starter_only is required/,
  );

  const rls = await client.query<RlsRow>(`
    select
      c.relname as "tableName",
      c.relrowsecurity as "rowSecurity",
      count(policy.policyname)::int as "policyCount"
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_policies policy on policy.schemaname = n.nspname and policy.tablename = c.relname
    where n.nspname = 'public'
      and c.relname = any($1::text[])
    group by c.relname, c.relrowsecurity
    order by c.relname
  `, [[
    'wager_ledger_entries',
    'wager_starter_budget',
    'wager_starter_grants',
    'wager_wallet_links',
  ]]);
  assert.deepEqual(rls.rows, [
    { tableName: 'wager_ledger_entries', rowSecurity: true, policyCount: 0 },
    { tableName: 'wager_starter_budget', rowSecurity: true, policyCount: 0 },
    { tableName: 'wager_starter_grants', rowSecurity: true, policyCount: 0 },
    { tableName: 'wager_wallet_links', rowSecurity: true, policyCount: 0 },
  ]);
}

export async function assertSettlementClosureWins(
  observer: Client,
  connectionString: string,
  fixture: Fixture,
): Promise<void> {
  const before = await stateSnapshot(observer, fixture);
  await withPgClient(connectionString, async (settlementClient) => {
    await withPgClient(connectionString, async (stakeClient) => {
      await settlementClient.query('begin');
      let transactionOpen = true;
      let pendingStake: Promise<RpcResult> | undefined;
      try {
        const settlementPid = await backendPid(settlementClient);
        const stakePid = await backendPid(stakeClient);
        await settlementClient.query("update markets set status = 'settling' where id = $1", [fixture.marketId]);
        let stakeSettled = false;
        pendingStake = stake(stakeClient, fixture, 'closure-race', true);
        void pendingStake.then(
          () => { stakeSettled = true; },
          () => { stakeSettled = true; },
        );
        assert.equal(
          await waitUntilBlocked(observer, {
            blockedPid: stakePid,
            blockerPid: settlementPid,
            isSettled: () => stakeSettled,
          }),
          true,
          'wager_stake did not wait on the market row held by settlement',
        );
        await settlementClient.query('commit');
        transactionOpen = false;
        assert.deepEqual(await pendingStake, { ok: false, code: 'closed' });
      } finally {
        if (transactionOpen) await settlementClient.query('rollback');
        if (pendingStake !== undefined) await pendingStake;
      }
    });
  });
  assert.deepEqual(await stateSnapshot(observer, fixture), before);
}

async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
  const row = result.rows[0];
  assert.ok(row);
  return row.pid;
}

async function waitUntilBlocked(
  observer: Client,
  wait: LockWait,
): Promise<boolean> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await observer.query<{ readonly blocked: boolean }>(
      'select $2::int = any(pg_blocking_pids($1::int)) as blocked',
      [wait.blockedPid, wait.blockerPid],
    );
    if (result.rows[0]?.blocked === true) return true;
    if (wait.isSettled()) return false;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('wager_stake lock wait was not observable after 1000 probes');
}
