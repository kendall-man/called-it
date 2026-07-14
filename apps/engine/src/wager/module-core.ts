import { presetStakes, WAGER_TUNABLES } from './constants.js';
import { createWagerCopy } from './copy.js';
import { formatAssetAmount } from './format.js';
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
    async currencyForMint(groupId) {
      return deps.runtimeMode === 'funded'
        ? deps.db.groupDefaultAsset(groupId)
        : 'sol';
    },

    async stakesAvailable(asset = 'sol') {
      if (!deps.stakeAcceptanceEnabled) return false;
      if (deps.runtimeMode === 'starter_only' && !deps.starterGrantsEnabled) return false;
      if (deps.runtimeMode === 'starter_only' && asset !== 'sol') return false;
      return !(await deps.db.getWagerStatus(asset)).paused;
    },

    handleStakeTap: (args) => handleStakeTap(deps, args),

    applySettlement: (marketId, options) => applySettlement(deps, marketId, options),

    settlementPayoutsLine: (marketId, outcome) => settlementPayoutsLine(deps, marketId, outcome),

    cardFooter: (asset = 'sol') => createWagerCopy(deps.solanaNetwork ?? 'devnet', asset).cardFooter(),

    presetLabels(asset = 'sol') {
      const [first, second, third] = presetStakes(asset);
      return [
        formatAssetAmount(first, asset),
        formatAssetAmount(second, asset),
        formatAssetAmount(third, asset),
      ];
    },

    presetLamports(index, asset = 'sol') {
      return presetStakes(asset)[index] ?? null;
    },

    registerSettlementRecovery(registry) {
      registry.every(WAGER_TUNABLES.SETTLEMENT_SWEEP_MS, () => sweeper.tick());
    },
  };
}
