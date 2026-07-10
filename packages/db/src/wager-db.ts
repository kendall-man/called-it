import { createClient } from '@supabase/supabase-js';
import { accountDbMethods } from './wager-db-account.js';
import {
  requireWagerDbClient,
  type WagerDb,
} from './wager-db-core.js';
import { operationsDbMethods } from './wager-db-operations.js';
import { rpcDbMethods } from './wager-db-rpc.js';

export {
  assertSafeInteger,
  multMilli,
  stakePayoutLamports,
  WAGER_MULT_SCALE,
  type WagerDb,
  type WagerDbClient,
  type WagerFilterBuilder,
  type WagerTableBuilder,
} from './wager-db-core.js';

export function createWagerDb(url: string, serviceRoleKey: string): WagerDb {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return wagerDbFromClient(client);
}

export function wagerDbFromClient(candidate: unknown): WagerDb {
  const client = requireWagerDbClient(candidate);
  return {
    ...accountDbMethods(client),
    ...operationsDbMethods(client),
    ...rpcDbMethods(client),
  } satisfies WagerDb;
}
