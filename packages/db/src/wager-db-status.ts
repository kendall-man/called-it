import { DbError } from './errors.js';
import type { WagerDb, WagerDbClient } from './wager-db-contract.js';
import { maybeRow, parseWagerStatusRow } from './wager-db-row-parsers.js';

type WagerStatusReaderDb = Pick<WagerDb, 'getWagerStatus'>;

export function wagerStatusReaderDbMethods(client: WagerDbClient): WagerStatusReaderDb {
  return {
    async getWagerStatus(asset) {
      const selectedAsset = asset ?? 'sol';
      const row = await maybeRow(
        'getWagerStatus',
        client
          .from('wager_asset_status')
          .select('asset, paused, reason, updated_at')
          .eq('asset', selectedAsset)
          .maybeSingle(),
        parseWagerStatusRow,
      );
      if (row === null) {
        throw new DbError('getWagerStatus', {
          message: `wager_asset_status row missing for ${selectedAsset} — apply migration 0022`,
        });
      }
      return row;
    },
  };
}
