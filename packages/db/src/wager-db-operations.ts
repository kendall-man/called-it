import { assertOk } from './errors.js';
import {
  assertSafeInteger,
  nowIso,
  OPEN_MARKET_STATUSES,
  RESIGNABLE_WITHDRAWAL_STATES,
  WAGER_STATUS_ROW_ID,
  withdrawalFromRaw,
} from './wager-db-core.js';
import type { WagerDb, WagerDbClient } from './wager-db-contract.js';
import {
  manyRows,
  parseIdRow,
  parseWithdrawalRow,
} from './wager-db-row-parsers.js';
import {
  fundedReplaySettlementDbMethods,
  settlementDbMethods,
} from './wager-db-settlement.js';
import { wagerStatusReaderDbMethods } from './wager-db-status.js';
import type { WagerWithdrawalState } from './wager-types.js';

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
  | 'settledFundedReplayMarketsMissingApplied'
  | 'getWagerStatus'
  | 'setWagerStatus'
  | 'openSolMarketIds'
>;

export function operationsDbMethods(client: WagerDbClient): OperationsDb {
  return {
    ...settlementDbMethods(client),
    ...fundedReplaySettlementDbMethods(client),
    ...wagerStatusReaderDbMethods(client),

    async withdrawalsInState(state) {
      const rows = await manyRows(
        'withdrawalsInState',
        client.from('wager_withdrawals').select('*').eq('state', state),
        parseWithdrawalRow,
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
      const rows = await manyRows(
        'openSolMarketIds',
        client
          .from('markets')
          .select('id')
          .eq('currency', 'sol')
          .in('status', [...OPEN_MARKET_STATUSES]),
        parseIdRow,
      );
      return rows.map((row) => row.id);
    },

  };
}
