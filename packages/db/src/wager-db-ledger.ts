import { DbError } from './errors.js';
import type { StarterOnlyWagerDb, WagerDb, WagerDbClient } from './wager-db-contract.js';
import { lamportsFromDb, lamportsToDb } from './wager-db-core.js';
import { manyRows, parseLamportsRow, parseNumericIdRow } from './wager-db-row-parsers.js';
import type { WagerLedgerEntry } from './wager-types.js';

type LedgerDb = Pick<WagerDb, 'postWagerLedger' | 'stakeDebitedLamportsForMarket'>;
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
        {
          ...entry,
          asset: entry.asset ?? 'sol',
          lamports: lamportsToDb('postWagerLedger.lamports', entry.lamports),
        },
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
    async stakeDebitedLamportsForMarket(marketId) {
      const rows = await manyRows(
        'stakeDebitedLamportsForMarket',
        client
          .from('wager_ledger_entries')
          .select('lamports')
          .eq('market_id', marketId)
          .eq('kind', 'stake'),
        parseLamportsRow,
      );
      return rows.reduce(
        (sum, row) => sum - lamportsFromDb('stakeDebitedLamportsForMarket', row.lamports),
        0n,
      );
    },
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
