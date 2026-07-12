import { DbError } from './errors.js';
import type { WagerDb, WagerDbClient } from './wager-db-contract.js';
import { WAGER_STATUS_ROW_ID } from './wager-db-core.js';
import { maybeRow, parseWagerStatusRow } from './wager-db-row-parsers.js';

type WagerStatusReaderDb = Pick<WagerDb, 'getWagerStatus'>;

export function wagerStatusReaderDbMethods(client: WagerDbClient): WagerStatusReaderDb {
  return {
    async getWagerStatus() {
      const row = await maybeRow(
        'getWagerStatus',
        client
          .from('wager_status')
          .select('paused, reason, updated_at')
          .eq('id', WAGER_STATUS_ROW_ID)
          .maybeSingle(),
        parseWagerStatusRow,
      );
      if (row === null) {
        throw new DbError('getWagerStatus', {
          message: 'wager_status row missing — apply migration 0002',
        });
      }
      return row;
    },
  };
}
