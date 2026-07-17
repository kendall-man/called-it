/**
 * Solvency monitor (broker model). Because winners are paid only from the
 * opposing pot, the treasury never owes more than it escrowed — so "solvent"
 * simply means the treasury holds enough to cover every user's cashout: the
 * total positive ledger balances PLUS open escrow PLUS pending withdrawal
 * reservations PLUS the enabled starter-cap reserve PLUS a fee buffer. A
 * violation persists the wager_status breaker (blocks NEW stakes only —
 * settlement credits and withdrawals never pause) and alerts ops to top the
 * devnet treasury up by hand. The breaker self-clears once the invariant holds
 * again, but only when the pause was solvency's own.
 */

import { SOLVENCY_PAUSE_REASON_PREFIX, WAGER_TUNABLES } from './constants.js';
import { WAGER_COPY } from './copy.js';
import { assertSafeLamports } from './format.js';
import type { WagerModuleDeps, WagerPositionRow, WagerSolvencySnapshot } from './port.js';

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

export function requiredSolvencyLamports(snapshot: WagerSolvencySnapshot): bigint {
  return (
    snapshot.positive_ledger_lamports +
    snapshot.open_escrow_lamports +
    snapshot.pending_withdrawal_lamports +
    snapshot.remaining_starter_cap_lamports +
    WAGER_TUNABLES.FEE_BUFFER_LAMPORTS
  );
}

export type SolvencyIntakeCheck =
  | { ok: true }
  | { ok: false; code: 'treasury_unavailable' | 'coverage_shortfall' };

/**
 * Stake intake calls this immediately before its atomic stake RPC. The starter
 * cap is reserved in full, so a successful new stake cannot consume coverage
 * that this check did not already reserve.
 */
export async function checkSolvencyBeforeStake(
  deps: WagerModuleDeps,
): Promise<SolvencyIntakeCheck> {
  const treasury = await deps.chain.treasuryBalanceLamports();
  if (!treasury.ok) {
    await deps.db.setSolvencyStatus(true, `${SOLVENCY_PAUSE_REASON_PREFIX} treasury_unavailable`);
    deps.log.error('wager_solvency_intake_unavailable', { error: treasury.error });
    return { ok: false, code: 'treasury_unavailable' };
  }
  const snapshot = await deps.db.getSolvencySnapshot();
  const required = requiredSolvencyLamports(snapshot);
  if (treasury.lamports >= required) return { ok: true };

  await deps.db.setSolvencyStatus(
    true,
    `${SOLVENCY_PAUSE_REASON_PREFIX} treasury ${treasury.lamports} < required ${required}`,
  );
  deps.log.error('wager_solvency_intake_shortfall', solvencyLogFields(treasury.lamports, snapshot, required));
  return { ok: false, code: 'coverage_shortfall' };
}

export interface SolvencyMonitor {
  tick(): Promise<void>;
}

export function createSolvencyMonitor(deps: WagerModuleDeps): SolvencyMonitor {
  async function run(): Promise<void> {
    const treasury = await deps.chain.treasuryBalanceLamports();
    if (!treasury.ok) {
      await deps.db.setSolvencyStatus(true, `${SOLVENCY_PAUSE_REASON_PREFIX} treasury_unavailable`);
      deps.log.warn('wager_solvency_balance_failed', { error: treasury.error });
      return;
    }
    const snapshot = await deps.db.getSolvencySnapshot();
    const required = requiredSolvencyLamports(snapshot);
    const status = await deps.db.getWagerStatus();

    if (treasury.lamports >= required) {
      const pausedBySolvency =
        status.paused && (status.reason ?? '').startsWith(SOLVENCY_PAUSE_REASON_PREFIX);
      if (pausedBySolvency) {
        await deps.db.setSolvencyStatus(false, null);
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
    await deps.db.setSolvencyStatus(
      true,
      `${SOLVENCY_PAUSE_REASON_PREFIX} treasury ${treasury.lamports} < required ${required}`,
    );
    deps.log.error('wager_insolvent', solvencyLogFields(treasury.lamports, snapshot, required));
    if (deps.opsChatId !== null) {
      deps.poster.post(deps.opsChatId, WAGER_COPY.opsSolvencyAlert(treasury.lamports, required));
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

function solvencyLogFields(
  treasuryLamports: bigint,
  snapshot: WagerSolvencySnapshot,
  requiredLamports: bigint,
): Record<string, string> {
  return {
    treasury: treasuryLamports.toString(),
    positiveLedger: snapshot.positive_ledger_lamports.toString(),
    openEscrow: snapshot.open_escrow_lamports.toString(),
    pendingWithdrawals: snapshot.pending_withdrawal_lamports.toString(),
    remainingStarterCap: snapshot.remaining_starter_cap_lamports.toString(),
    feeReserve: WAGER_TUNABLES.FEE_BUFFER_LAMPORTS.toString(),
    required: requiredLamports.toString(),
  };
}
