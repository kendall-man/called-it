import { assertOk } from './errors.js';
import {
  assertSafeInteger,
  nowIso,
  OPEN_MARKET_STATUSES,
  RESIGNABLE_WITHDRAWAL_STATES,
  withdrawalFromRaw,
} from './wager-db-core.js';
import type { WagerDb, WagerDbClient } from './wager-db-contract.js';
import {
  manyRows,
  parseIdCurrencyRow,
  parseWithdrawalRow,
} from './wager-db-row-parsers.js';
import {
  fundedReplaySettlementDbMethods,
  settlementDbMethods,
} from './wager-db-settlement.js';
import { wagerStatusReaderDbMethods } from './wager-db-status.js';
import type { WagerWithdrawalState } from './wager-types.js';
import type { WagerAsset } from '@calledit/market-engine';

type OperationsDb = Pick<
  WagerDb,
  | 'withdrawalsInState'
  | 'markWithdrawalSubmitted'
  | 'markWithdrawalConfirmed'
  | 'markWithdrawalFailed'
  | 'getMarketProbability'
  | 'getMarketAsset'
  | 'getSettlementOutcome'
  | 'hasSettlementApplied'
  | 'insertSettlementApplied'
  | 'settledWagerMarketsMissingApplied'
  | 'settledSolMarketsMissingApplied'
  | 'settledFundedReplayMarketsMissingApplied'
  | 'getWagerStatus'
  | 'setWagerStatus'
  | 'openWagerMarkets'
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

    async setWagerStatus(
      assetOrPaused: WagerAsset | boolean,
      pausedOrReason: boolean | string | null,
      maybeReason?: string | null,
    ) {
      const asset = typeof assetOrPaused === 'string' ? assetOrPaused : 'sol';
      const paused = typeof assetOrPaused === 'boolean' ? assetOrPaused : pausedOrReason as boolean;
      const reason = typeof assetOrPaused === 'boolean'
        ? pausedOrReason as string | null
        : maybeReason ?? null;
      assertOk(
        'setWagerStatus',
        await client
          .from('wager_asset_status')
          .update({ paused, reason, updated_at: nowIso() })
          .eq('asset', asset),
      );
    },

    // ── solvency support ───────────────────────────────────────────────────

    async openWagerMarkets() {
      const rows = await manyRows(
        'openWagerMarkets',
        client
          .from('markets')
          .select('id,currency')
          .in('currency', ['sol', 'usdc'])
          .in('status', [...OPEN_MARKET_STATUSES]),
        parseIdCurrencyRow,
      );
      return rows;
    },

    async openSolMarketIds() {
      return (await this.openWagerMarkets())
        .filter((market) => market.currency === 'sol')
        .map((market) => market.id);
    },

  };
}
