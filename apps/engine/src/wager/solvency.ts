/**
 * Solvency monitor: the treasury must always cover every ledger balance plus
 * the worst-case payout of every open sol market plus a fee buffer. A
 * violation persists the wager_status circuit breaker (blocks NEW stakes
 * only — settlement credits and withdrawals never pause), asks the devnet
 * faucet for a top-up, and alerts ops. The breaker self-clears once the
 * invariant holds again — but only when the pause was solvency's own; a
 * manual ops pause is never overridden.
 */

import {
  SOLVENCY_PAUSE_REASON_PREFIX,
  WAGER_TUNABLES,
} from './constants.js';
import { WAGER_COPY } from './copy.js';
import { assertSafeLamports } from './format.js';
import { payoutLamports } from './settlement.js';
import type { WagerModuleDeps, WagerPositionRow } from './port.js';

/**
 * Worst-case extra lamports a market can force out of the treasury beyond the
 * stakes it already escrowed: max over sides of Σ floor(stake×mult_milli/
 * MULT_SCALE) − Σ all stakes (non-void), floored at zero. Pending positions
 * count — they may still activate. Must match the wager_stake RPC's
 * liability-cap math.
 */
export function worstCaseLiabilityLamports(positions: WagerPositionRow[]): bigint {
  let totalStakes = 0n;
  let backPayout = 0n;
  let doubtPayout = 0n;
  for (const position of positions) {
    if (position.state === 'void') continue;
    const stake = assertSafeLamports(position.stake, `position ${position.id}`);
    totalStakes += stake;
    const payout = payoutLamports(stake, position.locked_multiplier);
    if (position.side === 'back') backPayout += payout;
    else doubtPayout += payout;
  }
  const worst = (backPayout > doubtPayout ? backPayout : doubtPayout) - totalStakes;
  return worst > 0n ? worst : 0n;
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

async function requestTopUp(
  deps: WagerModuleDeps,
  treasuryLamports: bigint,
  requiredLamports: bigint,
): Promise<string> {
  // Aim past bare coverage to the float target so one faucet grant doesn't
  // leave the breaker re-tripping on the next open market.
  const target = maxBigint(WAGER_TUNABLES.FLOAT_TARGET_LAMPORTS, requiredLamports);
  const shortfall = target - treasuryLamports;
  const ask = minBigint(shortfall, WAGER_TUNABLES.MAX_AIRDROP_REQUEST_LAMPORTS);
  const airdrop = await deps.chain.requestAirdrop(ask);
  if (airdrop.ok) {
    deps.log.info('wager_airdrop_requested', { lamports: ask.toString(), sig: airdrop.sig });
    return WAGER_COPY.opsAirdropRequested(ask);
  }
  deps.log.warn('wager_airdrop_failed', { lamports: ask.toString(), error: airdrop.error });
  return WAGER_COPY.opsAirdropFailed(airdrop.error);
}

export interface SolvencyMonitor {
  tick(): Promise<void>;
}

export function createSolvencyMonitor(deps: WagerModuleDeps): SolvencyMonitor {
  async function run(): Promise<void> {
    const treasury = await deps.chain.treasuryBalanceLamports();
    if (!treasury.ok) {
      // An RPC blip is not insolvency — never move the breaker on ignorance.
      deps.log.warn('wager_solvency_balance_failed', { error: treasury.error });
      return;
    }
    const ledgerTotal = await deps.db.totalLedgerLamports();
    let liabilities = 0n;
    for (const marketId of await deps.db.openSolMarketIds()) {
      const positions = await deps.db.positionsForMarket(marketId);
      liabilities += worstCaseLiabilityLamports(positions);
    }
    const required = ledgerTotal + liabilities + WAGER_TUNABLES.FEE_BUFFER_LAMPORTS;
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

    // Violated: pause first (stop the bleeding), then try to grow the float.
    await deps.db.setWagerStatus(
      true,
      `${SOLVENCY_PAUSE_REASON_PREFIX} treasury ${treasury.lamports} < required ${required}`,
    );
    deps.log.error('wager_insolvent', {
      treasury: treasury.lamports.toString(),
      ledgerTotal: ledgerTotal.toString(),
      liabilities: liabilities.toString(),
      required: required.toString(),
    });
    const airdropNote = await requestTopUp(deps, treasury.lamports, required);
    if (deps.opsChatId !== null) {
      deps.poster.post(
        deps.opsChatId,
        WAGER_COPY.opsSolvencyAlert(treasury.lamports, required, airdropNote),
      );
    }
  }

  return {
    async tick(): Promise<void> {
      try {
        await run();
      } catch (err) {
        deps.log.error('wager_solvency_check_failed', { error: String(err) });
      }
    },
  };
}
