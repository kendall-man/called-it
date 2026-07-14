/**
 * Solvency monitor (broker model). Because winners are paid only from the
 * opposing pot, the treasury never owes more than it escrowed — so "solvent"
 * simply means the treasury holds enough to cover every user's cashout: the
 * total ledger balance PLUS the stakes still escrowed in open markets (those
 * lamports were debited from ledger balances but are owed back on settlement),
 * plus a fee buffer. A violation persists the wager_status breaker (blocks NEW
 * stakes only — settlement credits and withdrawals never pause) and alerts ops
 * to top the devnet treasury up by hand. The breaker self-clears once the
 * invariant holds again, but only when the pause was solvency's own.
 */

import { SOLVENCY_PAUSE_REASON_PREFIX, WAGER_TUNABLES } from './constants.js';
import { createWagerCopy } from './copy.js';
import { assertSafeLamports } from './format.js';
import type { WagerModuleDeps, WagerPositionRow } from './port.js';
import { WAGER_ASSETS } from '@calledit/market-engine';

/**
 * Lamports escrowed in one market's non-void positions — debited from ledger
 * balances at stake time, owed back (as refunds/payouts bounded by this sum)
 * at settlement. Counting them makes the check detect a treasury drain BEFORE
 * a withdrawal bounces.
 */
export function escrowedLamports(positions: WagerPositionRow[]): bigint {
  let total = 0n;
  for (const position of positions) {
    if (position.state === 'void') continue;
    total += assertSafeLamports(position.stake, `position ${position.id}`);
  }
  return total;
}

export interface SolvencyMonitor {
  tick(): Promise<void>;
}

export function createSolvencyMonitor(deps: WagerModuleDeps): SolvencyMonitor {
  async function run(): Promise<void> {
    const openMarkets = await deps.db.openWagerMarkets();
    for (const asset of WAGER_ASSETS) {
      const copy = createWagerCopy(deps.solanaNetwork ?? 'devnet', asset);
      const treasury = await deps.chain.treasuryBalance(asset);
      if (!treasury.ok) {
        // An RPC blip is not insolvency — never move the breaker on ignorance.
        deps.log.warn('wager_solvency_balance_failed', { asset });
        continue;
      }
      const ledgerTotal = await deps.db.totalLedgerLamports(asset);
      let escrowed = 0n;
      for (const market of openMarkets) {
        if (market.currency !== asset) continue;
        escrowed += escrowedLamports(await deps.db.positionsForMarket(market.id));
      }
      const feeBuffer = asset === 'sol' ? WAGER_TUNABLES.FEE_BUFFER_LAMPORTS : 0n;
      const required = ledgerTotal + escrowed + feeBuffer;
      const status = await deps.db.getWagerStatus(asset);

      if (treasury.amountAtomic >= required) {
        const pausedBySolvency =
          status.paused && (status.reason ?? '').startsWith(SOLVENCY_PAUSE_REASON_PREFIX);
        if (pausedBySolvency) {
          await deps.db.setWagerStatus(asset, false, null);
          deps.log.info('wager_solvency_recovered', {
            asset,
            treasury: treasury.amountAtomic.toString(),
            required: required.toString(),
          });
          if (deps.opsChatId !== null) {
            deps.poster.post(deps.opsChatId, copy.opsSolvencyRecovered());
          }
        }
        continue;
      }

      // Violated: pause the affected asset, then alert ops for a manual top-up.
      await deps.db.setWagerStatus(
        asset,
        true,
        `${SOLVENCY_PAUSE_REASON_PREFIX} treasury ${treasury.amountAtomic} < required ${required}`,
      );
      deps.log.error('wager_insolvent', {
        asset,
        treasury: treasury.amountAtomic.toString(),
        ledgerTotal: ledgerTotal.toString(),
        escrowed: escrowed.toString(),
        required: required.toString(),
      });
      if (deps.opsChatId !== null) {
        deps.poster.post(deps.opsChatId, copy.opsSolvencyAlert(treasury.amountAtomic, required));
      }
    }
  }

  return {
    async tick(): Promise<void> {
      try {
        await run();
      } catch {
        deps.log.error('wager_solvency_check_failed');
      }
    },
  };
}
