import { createClient } from '@supabase/supabase-js';
import { accountDbMethods } from './wager-db-account.js';
import {
  requireWagerDbClient,
} from './wager-db-core.js';
import type { WagerDb } from './wager-db-contract.js';
import { operationsDbMethods } from './wager-db-operations.js';
import { rpcDbMethods } from './wager-db-rpc.js';
import { walletDbMethods } from './wager-db-wallet.js';

export {
  assertSafeInteger,
  multMilli,
  stakePayoutLamports,
  WAGER_MULT_SCALE,
} from './wager-db-core.js';
export type {
  WagerDb,
  WagerDbClient,
  WagerFilterBuilder,
  WagerTableBuilder,
} from './wager-db-contract.js';

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
    ...walletDbMethods(client),
  } satisfies WagerDb;
}
