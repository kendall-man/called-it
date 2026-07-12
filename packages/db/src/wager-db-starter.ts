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
): StarterOnlyWagerDb {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return starterOnlyWagerDbFromClient(client);
}

export function starterOnlyWagerDbFromClient(candidate: unknown): StarterOnlyWagerDb {
  const client: WagerDbClient = requireWagerDbClient(candidate);
  return {
    ...settlementLedgerDbMethods(client),
    ...settlementDbMethods(client),
    ...wagerStatusReaderDbMethods(client),
    ...starterStakeDbMethod(client),
  } satisfies StarterOnlyWagerDb;
}
