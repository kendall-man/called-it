/**
 * Idempotent peer-matched SOL settlement: a pure function of the settlement
 * outcome + the market's locked probability + positions, safe to run N times.
 * The treasury only escrowed the stakes; winners are paid from the opposing
 * pot (see wager/pot.ts settlementCredits), so payouts can never exceed escrow.
 * A sweeper cron re-runs any settled/voided sol market missing the marker,
 * closing the settle() crash window.
 */

import { WAGER_KEYS } from './constants.js';
import { WAGER_COPY } from './copy.js';
import { settlementCredits } from './pot.js';
import type { WagerSettlementDeps, WagerSettlementOutcome } from './port.js';
import { participantLabel } from '../points/presentation.js';

const PAYOUT_IDENTITY_LIMIT = 5;

export async function applySettlement(deps: WagerSettlementDeps, marketId: string): Promise<void> {
  if (await deps.db.hasSettlementApplied(marketId)) return;
  const outcome = await deps.db.getSettlementOutcome(marketId);
  if (outcome === null) return; // not settled yet — the sweeper will be back

  const probability = await deps.db.getMarketProbability(marketId);
  if (probability === null) {
    // Market vanished mid-settlement — never guess the ratio; the sweeper retries.
    deps.log.error('wager_settlement_no_market', { marketId });
    return;
  }

  const positions = await deps.db.positionsForMarket(marketId);
  const { refunds, payouts, voidedPendingIds, pots } = settlementCredits(
    positions,
    outcome,
    probability,
  );

  // Per-position refunds (full for pending/void, unmatched remainder for
  // losers). Idempotency key is per-position so re-runs and overlaps dedupe.
  for (const refund of refunds) {
    await deps.db.postWagerLedger({
      user_id: refund.userId,
      group_id: null,
      market_id: marketId,
      kind: 'refund',
      lamports: refund.lamports,
      idempotency_key: WAGER_KEYS.refund(refund.positionId),
    });
  }
  if (voidedPendingIds.length > 0) await deps.db.setPositionStates(voidedPendingIds, 'void');

  // Per-user winnings (own stake back + pro-rata share of the forfeited pot).
  for (const [userId, lamports] of payouts) {
    await deps.db.postWagerLedger({
      user_id: userId,
      group_id: null,
      market_id: marketId,
      kind: 'payout',
      lamports,
      idempotency_key: WAGER_KEYS.payout(marketId, userId),
    });
  }

  await deps.db.insertSettlementApplied(marketId);
  deps.log.info('wager_settlement_applied', {
    marketId,
    outcome,
    payouts: payouts.size,
    refunds: refunds.length,
    matchedFor: pots.matchedFor.toString(),
  });
}

/** Chat receipt line — SOL amounts are chat-only, public receipts untouched. */
export async function settlementPayoutsLine(
  deps: WagerSettlementDeps,
  marketId: string,
  outcome: WagerSettlementOutcome,
): Promise<string> {
  if (outcome === 'void') return WAGER_COPY.payoutsLineVoid();
  const probability = await deps.db.getMarketProbability(marketId);
  if (probability === null) return WAGER_COPY.payoutsLineNone();
  const positions = await deps.db.positionsForMarket(marketId);
  const { payouts, pots } = settlementCredits(positions, outcome, probability);
  // Nothing matched (one side empty) ⇒ everyone got their SOL back, no winners.
  if (pots.matchedFor === 0n || payouts.size === 0) return WAGER_COPY.payoutsLineNone();
  const winners = [...payouts].sort(([leftUserId], [rightUserId]) => leftUserId - rightUserId);
  const projectedWinners = winners.slice(0, PAYOUT_IDENTITY_LIMIT);
  const names = await deps.db.getUserNames(projectedWinners.map(([userId]) => userId));
  const parts = projectedWinners.map(([userId, lamports]) =>
    WAGER_COPY.payoutPart(
      participantLabel({ username: null, displayName: names.get(userId) ?? null }),
      lamports,
    ),
  );
  return WAGER_COPY.payoutsLine(parts, winners.length - projectedWinners.length);
}

export interface SettlementSweeper {
  tick(): Promise<void>;
}

/** Re-runs applySettlement for settled/voided sol markets missing the marker. */
export function createSettlementSweeper(deps: WagerSettlementDeps): SettlementSweeper {
  return {
    async tick(): Promise<void> {
      try {
        const marketIds = await deps.db.settledSolMarketsMissingApplied();
        for (const marketId of marketIds) {
          deps.log.info('wager_settlement_sweep', { marketId });
          await applySettlement(deps, marketId);
        }
      } catch {
        deps.log.error('wager_settlement_sweeper_failed');
      }
    },
  };
}
