import type { Client } from 'pg';

const EXPECTED_TABLES = [
  'groups',
  'users',
  'memberships',
  'ledger_entries',
  'fixtures',
  'claims',
  'markets',
  'positions',
  'settlements',
  'proofs',
  'wager_groups',
  'wager_wallet_links',
  'wager_ledger_entries',
  'wager_deposits',
  'wager_withdrawals',
  'wager_settlements_applied',
  'wager_status',
  'wager_starter_budget',
  'wager_starter_grants',
] as const;

const EXPECTED_VIEWS = [
  'public_receipts',
  'public_leaderboard',
  'public_evidence',
] as const;

const PRIVATE_TABLES = [
  'wager_groups',
  'wager_wallet_links',
  'wager_ledger_entries',
  'wager_deposits',
  'wager_withdrawals',
  'wager_settlements_applied',
  'wager_status',
  'wager_starter_budget',
  'wager_starter_grants',
] as const;

const EXPECTED_FUNCTIONS = [
  'wager_request_withdrawal(bigint,bigint)',
  'wager_stake(bigint,bigint,uuid,text,bigint,double precision,text,bigint,text,boolean)',
] as const;

const EXPECTED_REALTIME_MEMBERS = [
  'public.markets',
  'public.proofs',
  'public.settlements',
] as const;

type RelationRow = {
  readonly relname: string;
  readonly relkind: 'r' | 'v';
  readonly relrowsecurity: boolean;
};

type FunctionRow = {
  readonly signature: string;
  readonly prosecdef: boolean;
  readonly proconfig: readonly string[] | null;
  readonly service_role_can_execute: boolean;
  readonly anon_can_execute: boolean;
  readonly authenticated_can_execute: boolean;
  readonly public_can_execute: boolean;
};

type PublicationMemberRow = {
  readonly schemaname: string;
  readonly tablename: string;
};

export async function validateCalledItSchema(client: Client): Promise<void> {
  const relationRows = await loadRelations(client);
  assertRelations(relationRows, EXPECTED_TABLES, 'r');
  assertRelations(relationRows, EXPECTED_VIEWS, 'v');
  assertPrivateTableRls(relationRows);
  await assertRealtimePublication(client);
  await assertFunctionPrivileges(client);
}

async function loadRelations(client: Client): Promise<readonly RelationRow[]> {
  const names = [...EXPECTED_TABLES, ...EXPECTED_VIEWS];
  const result = await client.query<RelationRow>(
    `select c.relname, c.relkind, c.relrowsecurity
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any($1::text[])`,
    [names],
  );
  return result.rows;
}

function assertRelations(
  rows: readonly RelationRow[],
  expected: readonly string[],
  relkind: RelationRow['relkind'],
): void {
  const present = new Set(rows.filter((row) => row.relkind === relkind).map((row) => row.relname));
  const missing = expected.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`missing ${relkind === 'r' ? 'tables' : 'views'}: ${missing.join(', ')}`);
  }
}

function assertPrivateTableRls(rows: readonly RelationRow[]): void {
  const byName = new Map(rows.map((row) => [row.relname, row]));
  const missingRls = PRIVATE_TABLES.filter((name) => byName.get(name)?.relrowsecurity !== true);
  if (missingRls.length > 0) {
    throw new Error(`private tables without RLS: ${missingRls.join(', ')}`);
  }
}

async function assertRealtimePublication(client: Client): Promise<void> {
  const result = await client.query<PublicationMemberRow>(
    `select schemaname, tablename
     from pg_publication_tables
     where pubname = 'supabase_realtime'`,
  );
  const present = new Set(
    result.rows.map((row) => `${row.schemaname}.${row.tablename}`),
  );
  const missing = EXPECTED_REALTIME_MEMBERS.filter((member) => !present.has(member));
  const expected = new Set<string>(EXPECTED_REALTIME_MEMBERS);
  const unexpected = [...present].filter((member) => !expected.has(member)).sort();
  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }

  const differences = [
    ...(missing.length === 0 ? [] : [`missing ${missing.join(', ')}`]),
    ...(unexpected.length === 0 ? [] : [`unexpected ${unexpected.join(', ')}`]),
  ];
  throw new Error(`realtime publication membership mismatch: ${differences.join('; ')}`);
}

async function assertFunctionPrivileges(client: Client): Promise<void> {
  const result = await client.query<FunctionRow>(
    `select
       p.oid::regprocedure::text as signature,
       p.prosecdef,
       p.proconfig,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_can_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
       has_function_privilege('public', p.oid, 'EXECUTE') as public_can_execute
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any($1::text[])`,
    [['wager_stake', 'wager_request_withdrawal']],
  );
  const bySignature = new Map(result.rows.map((row) => [row.signature, row]));
  for (const signature of EXPECTED_FUNCTIONS) {
    const row = bySignature.get(signature);
    if (row === undefined) {
      throw new Error(`missing function: ${signature}`);
    }
    assertFunctionSecurity(row);
  }
}

function assertFunctionSecurity(row: FunctionRow): void {
  if (!row.prosecdef) {
    throw new Error(`function is not security definer: ${row.signature}`);
  }
  if (!row.proconfig?.includes('search_path=public')) {
    throw new Error(`function search_path is not public: ${row.signature}`);
  }
  if (!row.service_role_can_execute) {
    throw new Error(`service_role cannot execute: ${row.signature}`);
  }
  if (row.anon_can_execute || row.authenticated_can_execute || row.public_can_execute) {
    throw new Error(`public role can execute private function: ${row.signature}`);
  }
}
