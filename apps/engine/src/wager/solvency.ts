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
import { WAGER_COPY } from './copy.js';
import { assertSafeLamports } from './format.js';
import type { WagerModuleDeps, WagerPositionRow } from './port.js';

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
    const treasury = await deps.chain.treasuryBalanceLamports();
    if (!treasury.ok) {
      // An RPC blip is not insolvency — never move the breaker on ignorance.
      deps.log.warn('wager_solvency_balance_failed');
      return;
    }
    const ledgerTotal = await deps.db.totalLedgerLamports();
    let escrowed = 0n;
    for (const marketId of await deps.db.openSolMarketIds()) {
      escrowed += escrowedLamports(await deps.db.positionsForMarket(marketId));
    }
    const required = ledgerTotal + escrowed + WAGER_TUNABLES.FEE_BUFFER_LAMPORTS;
    const status = await deps.db.getWagerStatus();

    if (treasury.lamports >= required) {
      const pausedBySolvency =
        status.paused && (status.reason ?? '').startsWith(SOLVENCY_PAUSE_REASON_PREFIX);
      if (pausedBySolvency) {
        await deps.db.setWagerStatus(false, null);
        deps.log.info('wager_solvency_recovered', {
          treasury: treasury.lamports.toString(),
          required: required.toString(),
        });
        if (deps.opsChatId !== null) {
          deps.poster.post(deps.opsChatId, WAGER_COPY.opsSolvencyRecovered());
        }
      }
      return;
    }

    // Violated: pause first (stop the bleeding), then alert ops for a manual
    // faucet top-up. No automatic airdrop — the broker never fronts money.
    await deps.db.setWagerStatus(
      true,
      `${SOLVENCY_PAUSE_REASON_PREFIX} treasury ${treasury.lamports} < required ${required}`,
    );
    deps.log.error('wager_insolvent', {
      treasury: treasury.lamports.toString(),
      ledgerTotal: ledgerTotal.toString(),
      escrowed: escrowed.toString(),
      required: required.toString(),
    });
    if (deps.opsChatId !== null) {
      deps.poster.post(deps.opsChatId, WAGER_COPY.opsSolvencyAlert(treasury.lamports, required));
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
