import { createClient } from '@supabase/supabase-js';
import type { StarterOnlyWagerDb, WagerDbClient } from './wager-db-contract.js';
import { requireWagerDbClient } from './wager-db-core.js';
import { settlementLedgerDbMethods } from './wager-db-ledger.js';
import { settlementDbMethods } from './wager-db-settlement.js';
import { starterStakeDbMethod } from './wager-db-stake.js';
import { wagerStatusReaderDbMethods } from './wager-db-status.js';

export type { StarterOnlyWagerDb } from './wager-db-contract.js';
export type {
  WagerSettlementLedgerEntry,
  WagerStarterStakeInput,
} from './wager-types.js';

export function createStarterOnlyWagerDb(
  url: string,
  serviceRoleKey: string,
  allowedGroupIds: readonly number[] | undefined,
): StarterOnlyWagerDb {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return starterOnlyWagerDbFromClient(client, allowedGroupIds);
}

export function starterOnlyWagerDbFromClient(
  candidate: unknown,
  allowedGroupIds: readonly number[] | undefined,
): StarterOnlyWagerDb {
  const client: WagerDbClient = requireWagerDbClient(candidate);
  return {
    ...settlementLedgerDbMethods(client),
    ...settlementDbMethods(client, allowedGroupIds),
    ...wagerStatusReaderDbMethods(client),
    ...starterStakeDbMethod(client),
  } satisfies StarterOnlyWagerDb;
}
