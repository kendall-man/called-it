import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Pool, type Client } from 'pg';
import { withPgClient } from './postgres.js';

export const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/migrations');
export const USER_ID = 8501;
export const OTHER_USER_ID = 8502;
export const GROUP_ID = -8501;
export const PUBKEY_A = 'WalletIdentityPubkeyA111111111111111111111111';
export const PUBKEY_B = 'WalletIdentityPubkeyB222222222222222222222222';
export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
export const INTENT_HASH = 'c'.repeat(64);

export type RpcJson = Record<string, unknown> & {
  readonly ok: boolean;
  readonly code?: string;
  readonly intent_id?: string;
  readonly intent?: { readonly user_id: number };
};

export async function seedWalletFixtures(client: Client): Promise<void> {
  await client.query('insert into users (id, display_name) values ($1, $2), ($3, $4)', [USER_ID, 'u', OTHER_USER_ID, 'o']);
}

export async function createChallenge(client: Client | Pool, userId: number, pubkey: string, hash: string, ttlMinutes: number): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into wager_wallet_challenges (user_id, pubkey, challenge_hash, expires_at)
     values ($1, $2, decode($3, 'hex'), now() + ($4 || ' minutes')::interval)
     returning id`,
    [userId, pubkey, hash, ttlMinutes],
  );
  const row = result.rows[0];
  assert.ok(row);
  return row.id;
}

export async function verify(client: Client | Pool, id: string, userId: number, pubkey: string, hash: string): Promise<RpcJson> {
  return rpc(client, 'wager_verify_wallet_link($1,$2,$3,$4)', [id, userId, pubkey, hash]);
}

export async function createIntent(
  client: Client | Pool,
  marketId: string,
  hash: string,
  side: 'back' | 'doubt',
  lamports: number,
  ttlMinutes = 10,
): Promise<RpcJson> {
  return createIntentForUser(client, { userId: USER_ID, groupId: GROUP_ID, marketId, hash, side, lamports, ttlMinutes });
}

export async function createIntentForUser(
  client: Client | Pool,
  input: {
    readonly userId: number;
    readonly groupId: number;
    readonly marketId: string;
    readonly hash: string;
    readonly side: 'back' | 'doubt';
    readonly lamports: number;
    readonly ttlMinutes?: number;
  },
): Promise<RpcJson> {
  return rpc(client, 'wager_create_pending_stake_intent($1,$2,$3,$4,$5,$6,$7)', [
    input.userId,
    input.groupId,
    input.marketId,
    input.side,
    input.lamports,
    input.hash,
    new Date(Date.now() + (input.ttlMinutes ?? 10) * 60_000).toISOString(),
  ]);
}

export async function rpc(client: Client | Pool, signature: string, params: readonly unknown[]): Promise<RpcJson> {
  const result = await client.query<{ result: RpcJson }>(`select ${signature} as result`, [...params]);
  const row = result.rows[0];
  assert.ok(row);
  return row.result;
}

export async function countRows(client: Client, table: string): Promise<number> {
  const result = await client.query<{ count: string }>(`select count(*) from ${table}`);
  return Number(result.rows[0]?.count ?? '0');
}

export async function linkSnapshot(client: Client): Promise<unknown> {
  const result = await client.query(
    'select user_id::text, pubkey from wager_wallet_links order by user_id, pubkey',
  );
  return result.rows;
}

export async function secretSnapshot(client: Client): Promise<{ readonly challengeRaw: string; readonly intentRaw: string; readonly challengeHashBytes: number; readonly intentHashBytes: number | null }> {
  const result = await client.query(
    `select
       (select count(*)::text from information_schema.columns where table_name in ('wager_wallet_challenges','wager_pending_stake_intents') and column_name in ('challenge','challenge_material','intent_key','intent_secret')) as "challengeRaw",
       (select count(*)::text from information_schema.columns where table_name = 'wager_pending_stake_intents' and column_name in ('intent_key','intent_secret')) as "intentRaw",
       (select octet_length(challenge_hash) from wager_wallet_challenges limit 1) as "challengeHashBytes",
       (select octet_length(intent_key_hash) from wager_pending_stake_intents limit 1) as "intentHashBytes"`,
  );
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

export async function assertWalletFunctionPrivileges(client: Client, url: string): Promise<void> {
  const result = await client.query<{ service: boolean; anon: boolean; authenticated: boolean; public: boolean }>(
    `select bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')) as service,
            bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) as anon,
            bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) as authenticated,
            bool_or(has_function_privilege('public', p.oid, 'EXECUTE')) as public
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (
         p.proname like 'wager_%wallet%'
         or p.proname like 'wager_%stake_intent%'
         or p.proname like 'escrow_%wallet%'
       )`,
  );
  assert.deepEqual(result.rows[0], { service: true, anon: false, authenticated: false, public: false });
  for (const role of ['anon', 'authenticated'] as const) {
    await withPgClient(url, async (roleClient) => {
      await roleClient.query(`set role ${role}`);
      await assert.rejects(
        roleClient.query("select wager_resolve_active_stake_intent(1)"),
        /permission denied/,
      );
    });
  }
}

export async function withInsertDelay(
  client: Client,
  input: { readonly functionName: string; readonly triggerName: string; readonly table: string; readonly predicate: string },
  run: () => Promise<void>,
): Promise<void> {
  await client.query(`
    create function ${input.functionName}() returns trigger language plpgsql as $$
    begin
      if ${input.predicate} then
        perform pg_sleep(0.25);
      end if;
      return new;
    end;
    $$`);
  await client.query(`create trigger ${input.triggerName} before insert on ${input.table} for each row execute function ${input.functionName}()`);
  try {
    await run();
  } finally {
    await client.query(`drop trigger if exists ${input.triggerName} on ${input.table}`);
    await client.query(`drop function if exists ${input.functionName}()`);
  }
}

export function fulfilled<T>(results: readonly PromiseSettledResult<T>[]): T[] {
  return results.map((result) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    assert.fail(`unexpected rejected SQL race probe: ${String(result.reason)}`);
  });
}
