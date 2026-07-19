import { assertOk } from './errors.js';
import type { WagerDb, WagerDbClient } from './wager-db-contract.js';
import { SETTLED_MARKET_STATUSES } from './wager-db-core.js';
import {
  manyRows,
  maybeRow,
  parseAssetRow,
  parseIdRow,
  parseMarketIdRow,
  parseProbabilityRow,
  parseSettlementOutcomeRow,
} from './wager-db-row-parsers.js';

type SettlementDb = Pick<
  WagerDb,
  | 'getMarketProbability'
  | 'getMarketAsset'
  | 'getSettlementOutcome'
  | 'hasSettlementApplied'
  | 'insertSettlementApplied'
  | 'settledWagerMarketsMissingApplied'
  | 'settledSolMarketsMissingApplied'
>;
type FundedReplaySettlementDb = Pick<WagerDb, 'settledFundedReplayMarketsMissingApplied'>;

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

    async getMarketAsset(marketId) {
      const row = await maybeRow(
        'getMarketAsset',
        client.from('markets').select('asset:currency').eq('id', marketId).maybeSingle(),
        parseAssetRow,
      );
      return row?.asset ?? null;
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

    async settledWagerMarketsMissingApplied() {
      if (recoveryGroupIds !== undefined && recoveryGroupIds.length === 0) return [];
      // Two-step anti-join: PostgREST has no NOT EXISTS, and both sets stay
      // tiny (SOL markets only).
      let settledQuery = client
        .from('markets')
        .select('id')
        .in('currency', ['sol', 'usdc'])
        .eq('custody_mode', 'legacy')
        .eq('is_replay', false)
        .in('status', [...SETTLED_MARKET_STATUSES]);
      if (recoveryGroupIds !== undefined) {
        settledQuery = settledQuery.in('group_id', recoveryGroupIds);
      }
      const settled = await manyRows(
        'settledWagerMarketsMissingApplied.markets',
        settledQuery,
        parseIdRow,
      );
      if (settled.length === 0) return [];
      const ids = settled.map((row) => row.id);
      const applied = await manyRows(
        'settledWagerMarketsMissingApplied.applied',
        client.from('wager_settlements_applied').select('market_id').in('market_id', ids),
        parseMarketIdRow,
      );
      const appliedIds = new Set(applied.map((row) => row.market_id));
      return ids.filter((id) => !appliedIds.has(id));
    },

    async settledSolMarketsMissingApplied() {
      if (recoveryGroupIds !== undefined && recoveryGroupIds.length === 0) return [];
      let settledQuery = client
        .from('markets')
        .select('id')
        .eq('currency', 'sol')
        .eq('custody_mode', 'legacy')
        .eq('is_replay', false)
        .in('status', [...SETTLED_MARKET_STATUSES]);
      if (recoveryGroupIds !== undefined) settledQuery = settledQuery.in('group_id', recoveryGroupIds);
      const settled = await manyRows('settledSolMarketsMissingApplied.markets', settledQuery, parseIdRow);
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

export function fundedReplaySettlementDbMethods(
  client: WagerDbClient,
): FundedReplaySettlementDb {
  return {
    async settledFundedReplayMarketsMissingApplied() {
      const settled = await manyRows(
        'settledFundedReplayMarketsMissingApplied.markets',
        client
          .from('markets')
          .select('id')
          .in('currency', ['sol', 'usdc'])
          .eq('custody_mode', 'legacy')
          .eq('is_replay', true)
          .in('status', [...SETTLED_MARKET_STATUSES]),
        parseIdRow,
      );
      if (settled.length === 0) return [];
      const settledIds = settled.map((row) => row.id);
      const stakeRows = await manyRows(
        'settledFundedReplayMarketsMissingApplied.stakes',
        client
          .from('wager_ledger_entries')
          .select('market_id')
          .in('market_id', settledIds)
          .eq('kind', 'stake'),
        parseMarketIdRow,
      );
      const fundedIds = [...new Set(stakeRows.map((row) => row.market_id))];
      if (fundedIds.length === 0) return [];
      const applied = await manyRows(
        'settledFundedReplayMarketsMissingApplied.applied',
        client.from('wager_settlements_applied').select('market_id').in('market_id', fundedIds),
        parseMarketIdRow,
      );
      const appliedIds = new Set(applied.map((row) => row.market_id));
      return fundedIds.filter((id) => !appliedIds.has(id));
    },
  };
}
