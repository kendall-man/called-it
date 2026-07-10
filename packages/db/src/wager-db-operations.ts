import type { MarketStatus, SettlementOutcome } from '@calledit/market-engine';
import { assertOk, DbError } from './errors.js';
import {
  assertSafeInteger,
  manyRows,
  maybeRow,
  nowIso,
  OPEN_MARKET_STATUSES,
  RESIGNABLE_WITHDRAWAL_STATES,
  SETTLED_MARKET_STATUSES,
  WAGER_STATUS_ROW_ID,
  withdrawalFromRaw,
  type RawWithdrawalRow,
  type WagerDb,
  type WagerDbClient,
} from './wager-db-core.js';
import type { WagerStatusRow, WagerWithdrawalState } from './wager-types.js';

type OperationsDb = Pick<
  WagerDb,
  | 'withdrawalsInState'
  | 'markWithdrawalSubmitted'
  | 'markWithdrawalConfirmed'
  | 'markWithdrawalFailed'
  | 'getMarketProbability'
  | 'getSettlementOutcome'
  | 'hasSettlementApplied'
  | 'insertSettlementApplied'
  | 'settledSolMarketsMissingApplied'
  | 'getWagerStatus'
  | 'setWagerStatus'
  | 'openSolMarketIds'
>;

export function operationsDbMethods(client: WagerDbClient): OperationsDb {
  return {
    async withdrawalsInState(state) {
      const rows = await manyRows<RawWithdrawalRow[]>(
        'withdrawalsInState',
        client.from('wager_withdrawals').select('*').eq('state', state),
      );
      return rows.map((row) => withdrawalFromRaw('withdrawalsInState', row));
    },

    async markWithdrawalSubmitted(id, tx) {
      assertSafeInteger('markWithdrawalSubmitted.last_valid_block_height', tx.last_valid_block_height);
      assertOk(
        'markWithdrawalSubmitted',
        await client
          .from('wager_withdrawals')
          .update({
            state: 'submitted' satisfies WagerWithdrawalState,
            tx_sig: tx.tx_sig,
            raw_tx_b64: tx.raw_tx_b64,
            last_valid_block_height: tx.last_valid_block_height,
            updated_at: nowIso(),
          })
          .eq('id', id)
          .in('state', [...RESIGNABLE_WITHDRAWAL_STATES]),
      );
    },

    async markWithdrawalConfirmed(id) {
      assertOk(
        'markWithdrawalConfirmed',
        await client
          .from('wager_withdrawals')
          .update({ state: 'confirmed' satisfies WagerWithdrawalState, updated_at: nowIso() })
          .eq('id', id)
          .in('state', ['submitted' satisfies WagerWithdrawalState]),
      );
    },

    async markWithdrawalFailed(id, error) {
      assertOk(
        'markWithdrawalFailed',
        await client
          .from('wager_withdrawals')
          .update({ state: 'failed' satisfies WagerWithdrawalState, error, updated_at: nowIso() })
          .eq('id', id)
          .in('state', [...RESIGNABLE_WITHDRAWAL_STATES]),
      );
    },

    // ── settlements (money-movement marker) ────────────────────────────────

    async getMarketProbability(marketId) {
      const row = await maybeRow<{ quote_probability: number }>(
        'getMarketProbability',
        client.from('markets').select('quote_probability').eq('id', marketId).maybeSingle(),
      );
      return row?.quote_probability ?? null;
    },

    async getSettlementOutcome(marketId) {
      const row = await maybeRow<{ outcome: SettlementOutcome }>(
        'getSettlementOutcome',
        client.from('settlements').select('outcome').eq('market_id', marketId).maybeSingle(),
      );
      return row?.outcome ?? null;
    },

    async hasSettlementApplied(marketId) {
      const row = await maybeRow<{ market_id: string }>(
        'hasSettlementApplied',
        client
          .from('wager_settlements_applied')
          .select('market_id')
          .eq('market_id', marketId)
          .maybeSingle(),
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
      // Two-step anti-join: PostgREST has no NOT EXISTS, and both sets stay
      // tiny (SOL markets only).
      const settled = await manyRows<Array<{ id: string }>>(
        'settledSolMarketsMissingApplied.markets',
        client
          .from('markets')
          .select('id')
          .eq('currency', 'sol')
          .in('status', [...SETTLED_MARKET_STATUSES]),
      );
      if (settled.length === 0) return [];
      const ids = settled.map((row) => row.id);
      const applied = await manyRows<Array<{ market_id: string }>>(
        'settledSolMarketsMissingApplied.applied',
        client.from('wager_settlements_applied').select('market_id').in('market_id', ids),
      );
      const appliedIds = new Set(applied.map((row) => row.market_id));
      return ids.filter((id) => !appliedIds.has(id));
    },

    // ── circuit breaker ────────────────────────────────────────────────────

    async getWagerStatus() {
      const row = await maybeRow<WagerStatusRow>(
        'getWagerStatus',
        client
          .from('wager_status')
          .select('paused, reason, updated_at')
          .eq('id', WAGER_STATUS_ROW_ID)
          .maybeSingle(),
      );
      if (!row) {
        throw new DbError('getWagerStatus', {
          message: 'wager_status row missing — apply migration 0002',
        });
      }
      return row;
    },

    async setWagerStatus(paused, reason) {
      assertOk(
        'setWagerStatus',
        await client
          .from('wager_status')
          .update({ paused, reason, updated_at: nowIso() })
          .eq('id', WAGER_STATUS_ROW_ID),
      );
    },

    // ── solvency support ───────────────────────────────────────────────────

    async openSolMarketIds() {
      const rows = await manyRows<Array<{ id: string }>>(
        'openSolMarketIds',
        client
          .from('markets')
          .select('id')
          .eq('currency', 'sol')
          .in('status', [...OPEN_MARKET_STATUSES]),
      );
      return rows.map((row) => row.id);
    },

  };
}
