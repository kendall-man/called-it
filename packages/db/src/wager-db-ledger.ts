import { DbError } from './errors.js';
import type { StarterOnlyWagerDb, WagerDb, WagerDbClient } from './wager-db-contract.js';
import { lamportsToDb } from './wager-db-core.js';
import { manyRows, parseNumericIdRow } from './wager-db-row-parsers.js';
import type { WagerLedgerEntry } from './wager-types.js';

type LedgerDb = Pick<WagerDb, 'postWagerLedger'>;
type SettlementLedgerDb = Pick<StarterOnlyWagerDb, 'postWagerLedger'>;

async function insertLedgerEntry(
  client: WagerDbClient,
  entry: WagerLedgerEntry,
): Promise<{ inserted: boolean }> {
  const rows = await manyRows(
    'postWagerLedger',
    client
      .from('wager_ledger_entries')
      .upsert(
        { ...entry, lamports: lamportsToDb('postWagerLedger.lamports', entry.lamports) },
        { onConflict: 'idempotency_key', ignoreDuplicates: true },
      )
      .select('id'),
    parseNumericIdRow,
  );
  return { inserted: rows.length > 0 };
}

export function ledgerDbMethods(client: WagerDbClient): LedgerDb {
  return {
    postWagerLedger: (entry) => insertLedgerEntry(client, entry),
  };
}

export function settlementLedgerDbMethods(client: WagerDbClient): SettlementLedgerDb {
  return {
    async postWagerLedger(entry) {
      if (entry.kind !== 'payout' && entry.kind !== 'refund') {
        throw new DbError('postWagerLedger', {
          message: 'starter facade accepts only payout or refund ledger effects',
        });
      }
      return insertLedgerEntry(client, entry);
    },
  };
}
