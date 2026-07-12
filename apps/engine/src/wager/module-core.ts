import { WAGER_TUNABLES } from './constants.js';
import { WAGER_COPY } from './copy.js';
import { formatSolAmount } from './format.js';
import {
  applySettlement,
  createSettlementSweeper,
  settlementPayoutsLine,
} from './settlement.js';
import { handleStakeTap } from './stake.js';
import type { WagerModuleCore, WagerStakeDeps } from './port.js';

export function createWagerModuleCore(deps: WagerStakeDeps): WagerModuleCore {
  const sweeper = createSettlementSweeper(deps);
  return {
    async currencyForMint() {
      return 'sol';
    },

    handleStakeTap: (args) => handleStakeTap(deps, args),

    applySettlement: (marketId) => applySettlement(deps, marketId),

    settlementPayoutsLine: (marketId, outcome) => settlementPayoutsLine(deps, marketId, outcome),

    cardFooter: () => WAGER_COPY.cardFooter(),

    presetLabels() {
      const [first, second, third] = WAGER_TUNABLES.PRESET_STAKES_LAMPORTS;
      return [formatSolAmount(first), formatSolAmount(second), formatSolAmount(third)];
    },

    presetLamports(index) {
      return WAGER_TUNABLES.PRESET_STAKES_LAMPORTS[index] ?? null;
    },

    registerSettlementRecovery(registry) {
      registry.every(WAGER_TUNABLES.SETTLEMENT_SWEEP_MS, () => sweeper.tick());
    },
  };
}
