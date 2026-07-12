import { assertOk } from './errors.js';
import type { WagerDb, WagerDbClient } from './wager-db-contract.js';
import { SETTLED_MARKET_STATUSES } from './wager-db-core.js';
import {
  manyRows,
  maybeRow,
  parseIdRow,
  parseMarketIdRow,
  parseProbabilityRow,
  parseSettlementOutcomeRow,
} from './wager-db-row-parsers.js';

type SettlementDb = Pick<
  WagerDb,
  | 'getMarketProbability'
  | 'getSettlementOutcome'
  | 'hasSettlementApplied'
  | 'insertSettlementApplied'
  | 'settledSolMarketsMissingApplied'
>;

export function settlementDbMethods(
  client: WagerDbClient,
  allowedGroupIds?: readonly number[],
): SettlementDb {
  const recoveryGroupIds = allowedGroupIds === undefined ? undefined : [...allowedGroupIds];
  return {
    async getMarketProbability(marketId) {
      const row = await maybeRow(
        'getMarketProbability',
        client.from('markets').select('quote_probability').eq('id', marketId).maybeSingle(),
        parseProbabilityRow,
      );
      return row?.quote_probability ?? null;
    },

    async getSettlementOutcome(marketId) {
      const row = await maybeRow(
        'getSettlementOutcome',
        client.from('settlements').select('outcome').eq('market_id', marketId).maybeSingle(),
        parseSettlementOutcomeRow,
      );
      return row?.outcome ?? null;
    },

    async hasSettlementApplied(marketId) {
      const row = await maybeRow(
        'hasSettlementApplied',
        client
          .from('wager_settlements_applied')
          .select('market_id')
          .eq('market_id', marketId)
          .maybeSingle(),
        parseMarketIdRow,
      );
      return row !== null;
    },

    async insertSettlementApplied(marketId) {
      assertOk(
        'insertSettlementApplied',
        await client
          .from('wager_settlements_applied')
          .upsert({ market_id: marketId }, { onConflict: 'market_id', ignoreDuplicates: true }),
      );
    },

    async settledSolMarketsMissingApplied() {
      if (recoveryGroupIds !== undefined && recoveryGroupIds.length === 0) return [];
      // Two-step anti-join: PostgREST has no NOT EXISTS, and both sets stay
      // tiny (SOL markets only).
      let settledQuery = client
        .from('markets')
        .select('id')
        .eq('currency', 'sol')
        .in('status', [...SETTLED_MARKET_STATUSES]);
      if (recoveryGroupIds !== undefined) {
        settledQuery = settledQuery.in('group_id', recoveryGroupIds);
      }
      const settled = await manyRows(
        'settledSolMarketsMissingApplied.markets',
        settledQuery,
        parseIdRow,
      );
      if (settled.length === 0) return [];
      const ids = settled.map((row) => row.id);
      const applied = await manyRows(
        'settledSolMarketsMissingApplied.applied',
        client.from('wager_settlements_applied').select('market_id').in('market_id', ids),
        parseMarketIdRow,
      );
      const appliedIds = new Set(applied.map((row) => row.market_id));
      return ids.filter((id) => !appliedIds.has(id));
    },
  };
}
