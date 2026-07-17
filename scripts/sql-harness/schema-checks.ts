import type { Client } from 'pg';
import {
  TELEGRAM_FUNCTION_NAMES,
  TELEGRAM_FUNCTIONS,
  TELEGRAM_TABLES,
} from './telegram-ingress-contract.js';

const BASE_TABLES = [
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
  'wager_wallet_reconciliation_items',
  'wager_wallet_challenges',
  'wager_wallet_link_history',
  'wager_pending_stake_intents',
] as const;

const LEGACY_EXPECTED_VIEWS = [
  'public_receipts',
  'public_leaderboard',
  'public_evidence',
] as const;

const PRODUCT_EXPECTED_VIEWS = [
  'public_receipts',
  'public_group_board',
  'public_evidence',
] as const;

const BASE_PRIVATE_TABLES = [
  'wager_groups',
  'wager_wallet_links',
  'wager_ledger_entries',
  'wager_deposits',
  'wager_withdrawals',
  'wager_settlements_applied',
  'wager_status',
  'wager_starter_budget',
  'wager_starter_grants',
  'wager_wallet_reconciliation_items',
  'wager_wallet_challenges',
  'wager_wallet_link_history',
  'wager_pending_stake_intents',
] as const;

const PRODUCT_PRIVATE_TABLES = ['onboarding_events'] as const;

const SETTLEMENT_PROOF_TABLES = ['settlement_proof_jobs'] as const;

const BOT_ONBOARDING_TABLES = ['bot_group_ready_markers'] as const;

const PROOF_SUBMISSION_OUTBOX_TABLES = ['proof_submission_outbox'] as const;

const SETTLEMENT_PROOF_FUNCTIONS = [
  'settlement_record_terminal(uuid,text,bigint,bigint[],text,timestamp with time zone,integer,integer,integer,integer)',
  'settlement_mark_posted(uuid,timestamp with time zone)',
  'proof_record_state(uuid,text,integer,bigint,jsonb,text,text,text,timestamp with time zone)',
  'settlement_proof_enqueue(uuid,text,timestamp with time zone,timestamp with time zone,integer,integer,integer,integer)',
  'settlement_proof_lease(text,text,timestamp with time zone,integer)',
  'settlement_proof_complete(uuid,text,text,uuid,timestamp with time zone)',
  'settlement_proof_retry(uuid,text,text,uuid,text,integer,timestamp with time zone)',
  'settlement_proof_dead_letter(uuid,text,text,uuid,text,timestamp with time zone)',
  'settlement_terminal_gaps(integer)',
  'settlement_reconcile_terminal_jobs(timestamp with time zone,integer,integer,integer,integer,integer,integer)',
  'settlement_proof_backlog(text,timestamp with time zone)',
] as const;

const SETTLEMENT_PROOF_FUNCTION_NAMES = [
  'settlement_record_terminal',
  'settlement_mark_posted',
  'proof_record_state',
  'settlement_proof_enqueue',
  'settlement_proof_lease',
  'settlement_proof_complete',
  'settlement_proof_retry',
  'settlement_proof_dead_letter',
  'settlement_terminal_gaps',
  'settlement_reconcile_terminal_jobs',
  'settlement_proof_backlog',
] as const;

const BOT_ONBOARDING_FUNCTIONS = [
  'bot_mark_group_ready(bigint,text)',
] as const;

const BOT_ONBOARDING_FUNCTION_NAMES = ['bot_mark_group_ready'] as const;

const PROOF_SUBMISSION_OUTBOX_FUNCTIONS = [
  'proof_submission_get(uuid)',
  'proof_submission_prepare(uuid,text,text,bigint,jsonb,timestamp with time zone)',
  'proof_submission_mark_broadcast(uuid,integer,text,timestamp with time zone)',
  'proof_submission_mark_landed(uuid,integer,text,timestamp with time zone)',
  'proof_submission_mark_expired(uuid,integer,text,timestamp with time zone)',
] as const;

const PROOF_SUBMISSION_OUTBOX_FUNCTION_NAMES = [
  'proof_submission_get',
  'proof_submission_prepare',
  'proof_submission_mark_broadcast',
  'proof_submission_mark_landed',
  'proof_submission_mark_expired',
] as const;

const BASE_FUNCTIONS = [
  'wager_request_withdrawal(bigint,bigint)',
  'wager_stake(bigint,bigint,uuid,text,bigint,double precision,text,bigint,text,boolean)',
  'wager_decode_sha256_hex(text)',
  'wager_verify_wallet_link(uuid,bigint,text,text)',
  'wager_create_pending_stake_intent(bigint,bigint,uuid,text,bigint,text,timestamp with time zone)',
  'wager_resolve_active_stake_intent(bigint)',
  'wager_mark_stake_intent_funded(bigint,uuid)',
  'wager_consume_ready_stake_intent(bigint,uuid)',
  'wager_cancel_stake_intent(bigint,uuid)',
] as const;

const LEGACY_REALTIME_MEMBERS = [
  'public.markets',
  'public.proofs',
  'public.settlements',
] as const;

const PRODUCT_REALTIME_MEMBERS = [
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

type TablePrivilegeRow = {
  readonly relname: string;
  readonly service_role_can_access: boolean;
  readonly anon_can_access: boolean;
  readonly authenticated_can_access: boolean;
  readonly public_can_access: boolean;
};

export interface SchemaCheckOptions {
  readonly telegram?: boolean;
  readonly settlementProofJobs?: boolean;
  readonly publicProductViews?: boolean;
  readonly botOnboarding?: boolean;
  readonly proofSubmissionOutbox?: boolean;
}

export async function validateCalledItSchema(
  client: Client,
  options: SchemaCheckOptions = {},
): Promise<void> {
  const telegram = options.telegram ?? true;
  const settlementProofJobs = options.settlementProofJobs ?? options.telegram === undefined;
  const publicProductViews = options.publicProductViews ?? true;
  const usesLegacyMigrationOptions = options.telegram !== undefined
    || options.settlementProofJobs !== undefined
    || options.publicProductViews !== undefined;
  const botOnboarding = options.botOnboarding ?? !usesLegacyMigrationOptions;
  const proofSubmissionOutbox = options.proofSubmissionOutbox ?? !usesLegacyMigrationOptions;
  const expectedViews = publicProductViews ? PRODUCT_EXPECTED_VIEWS : LEGACY_EXPECTED_VIEWS;
  const expectedRealtimeMembers = publicProductViews
    ? PRODUCT_REALTIME_MEMBERS
    : LEGACY_REALTIME_MEMBERS;
  const expectedTables = [
    ...BASE_TABLES,
    ...(telegram ? TELEGRAM_TABLES : []),
    ...(settlementProofJobs ? SETTLEMENT_PROOF_TABLES : []),
    ...(publicProductViews ? PRODUCT_PRIVATE_TABLES : []),
    ...(botOnboarding ? BOT_ONBOARDING_TABLES : []),
    ...(proofSubmissionOutbox ? PROOF_SUBMISSION_OUTBOX_TABLES : []),
  ];
  const privateTables = [
    ...BASE_PRIVATE_TABLES,
    ...(telegram ? TELEGRAM_TABLES : []),
    ...(settlementProofJobs ? SETTLEMENT_PROOF_TABLES : []),
    ...(publicProductViews ? PRODUCT_PRIVATE_TABLES : []),
    ...(botOnboarding ? BOT_ONBOARDING_TABLES : []),
    ...(proofSubmissionOutbox ? PROOF_SUBMISSION_OUTBOX_TABLES : []),
  ];
  const directTableAccessRestricted = [
    ...(botOnboarding ? BOT_ONBOARDING_TABLES : []),
    ...(proofSubmissionOutbox ? PROOF_SUBMISSION_OUTBOX_TABLES : []),
  ];
  const expectedFunctions = [
    ...BASE_FUNCTIONS,
    ...(telegram ? TELEGRAM_FUNCTIONS : []),
    ...(settlementProofJobs ? SETTLEMENT_PROOF_FUNCTIONS : []),
    ...(botOnboarding ? BOT_ONBOARDING_FUNCTIONS : []),
    ...(proofSubmissionOutbox ? PROOF_SUBMISSION_OUTBOX_FUNCTIONS : []),
  ];
  const functionNames = telegram
    ? [
        'wager_stake',
        'wager_request_withdrawal',
        'wager_decode_sha256_hex',
        'wager_verify_wallet_link',
        'wager_create_pending_stake_intent',
        'wager_resolve_active_stake_intent',
        'wager_mark_stake_intent_funded',
        'wager_consume_ready_stake_intent',
        'wager_cancel_stake_intent',
        ...TELEGRAM_FUNCTION_NAMES,
      ]
    : [
        'wager_stake',
        'wager_request_withdrawal',
        'wager_decode_sha256_hex',
        'wager_verify_wallet_link',
        'wager_create_pending_stake_intent',
        'wager_resolve_active_stake_intent',
        'wager_mark_stake_intent_funded',
        'wager_consume_ready_stake_intent',
        'wager_cancel_stake_intent',
      ];
  functionNames.push(...(settlementProofJobs ? SETTLEMENT_PROOF_FUNCTION_NAMES : []));
  functionNames.push(...(botOnboarding ? BOT_ONBOARDING_FUNCTION_NAMES : []));
  functionNames.push(...(proofSubmissionOutbox ? PROOF_SUBMISSION_OUTBOX_FUNCTION_NAMES : []));
  const relationRows = await loadRelations(client, expectedTables, expectedViews);
  assertRelations(relationRows, expectedTables, 'r');
  assertRelations(relationRows, expectedViews, 'v');
  assertPrivateTableRls(relationRows, privateTables);
  await assertNoPrivateTablePolicies(client, privateTables);
  await assertNoDirectTableAccess(client, directTableAccessRestricted);
  await assertRealtimePublication(client, expectedRealtimeMembers);
  await assertFunctionPrivileges(client, expectedFunctions, functionNames);
}

async function assertNoDirectTableAccess(client: Client, tableNames: readonly string[]): Promise<void> {
  if (tableNames.length === 0) {
    return;
  }
  const result = await client.query<TablePrivilegeRow>(
    `select
       c.relname,
       has_table_privilege('service_role', c.oid, 'select, insert, update, delete, truncate, references, trigger') as service_role_can_access,
       has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger') as anon_can_access,
       has_table_privilege('authenticated', c.oid, 'select, insert, update, delete, truncate, references, trigger') as authenticated_can_access,
       has_table_privilege('public', c.oid, 'select, insert, update, delete, truncate, references, trigger') as public_can_access
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any($1::text[])`,
    [tableNames],
  );
  const accessible = result.rows.filter(
    (row) => row.service_role_can_access
      || row.anon_can_access
      || row.authenticated_can_access
      || row.public_can_access,
  );
  if (accessible.length > 0) {
    throw new Error(`private tables with direct role access: ${accessible.map((row) => row.relname).join(', ')}`);
  }
}

async function loadRelations(
  client: Client,
  expectedTables: readonly string[],
  expectedViews: readonly string[],
): Promise<readonly RelationRow[]> {
  const names = [...expectedTables, ...expectedViews];
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

function assertPrivateTableRls(rows: readonly RelationRow[], privateTables: readonly string[]): void {
  const byName = new Map(rows.map((row) => [row.relname, row]));
  const missingRls = privateTables.filter((name) => byName.get(name)?.relrowsecurity !== true);
  if (missingRls.length > 0) {
    throw new Error(`private tables without RLS: ${missingRls.join(', ')}`);
  }
}

async function assertNoPrivateTablePolicies(client: Client, privateTables: readonly string[]): Promise<void> {
  const result = await client.query<{ readonly tablename: string }>(
    `select tablename
     from pg_policies
     where schemaname = 'public' and tablename = any($1::text[])`,
    [privateTables],
  );
  if (result.rows.length > 0) {
    throw new Error(`private tables with unexpected RLS policies: ${result.rows.map((row) => row.tablename).join(', ')}`);
  }
}

async function assertRealtimePublication(
  client: Client,
  expectedRealtimeMembers: readonly string[],
): Promise<void> {
  const result = await client.query<PublicationMemberRow>(
    `select schemaname, tablename
     from pg_publication_tables
     where pubname = 'supabase_realtime'`,
  );
  const present = new Set(
    result.rows.map((row) => `${row.schemaname}.${row.tablename}`),
  );
  const missing = expectedRealtimeMembers.filter((member) => !present.has(member));
  const expected = new Set<string>(expectedRealtimeMembers);
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

async function assertFunctionPrivileges(
  client: Client,
  expectedFunctions: readonly string[],
  functionNames: readonly string[],
): Promise<void> {
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
    [functionNames],
  );
  const bySignature = new Map(result.rows.map((row) => [row.signature, row]));
  for (const signature of expectedFunctions) {
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
