/**
 * Idempotent SOL settlement: a pure function of settlements + positions, safe
 * to run N times. Mirrors the Rep settle() money moves (refund still-pending
 * and everyone-on-void, pay winners) with bigint lamports and floor payouts
 * at MULT_SCALE, then stamps wager_settlements_applied. A sweeper cron
 * re-runs any settled/voided sol market missing the stamp, closing the
 * settle() crash window for SOL without touching Rep's.
 */

import { WAGER_KEYS, WAGER_TUNABLES } from './constants.js';
import { WAGER_COPY } from './copy.js';
import { assertSafeLamports } from './format.js';
import type {
  WagerModuleDeps,
  WagerPositionRow,
  WagerSettlementOutcome,
} from './port.js';

const MULT_SCALE_BIGINT = BigInt(WAGER_TUNABLES.MULT_SCALE);

/**
 * Payout quantization: multiplier → milli-units by round, then bigint
 * floor division. Must match the SQL in migration 0002's wager_stake
 * liability math (same MULT_SCALE — asserted in constants.test.ts).
 */
export function payoutLamports(stakeLamports: bigint, lockedMultiplier: number): bigint {
  const multMilli = BigInt(Math.round(lockedMultiplier * WAGER_TUNABLES.MULT_SCALE));
  return (stakeLamports * multMilli) / MULT_SCALE_BIGINT; // non-negative ⇒ floor
}

/** Winning lamports per user — active positions on the winning side only. */
export function computeWinnersLamports(
  positions: WagerPositionRow[],
  outcome: WagerSettlementOutcome,
): Map<number, bigint> {
  const winners = new Map<number, bigint>();
  if (outcome === 'void') return winners;
  const winningSide = outcome === 'claim_won' ? 'back' : 'doubt';
  for (const position of positions) {
    if (position.state !== 'active' || position.side !== winningSide) continue;
    const stake = assertSafeLamports(position.stake, `position ${position.id}`);
    const amount = payoutLamports(stake, position.locked_multiplier);
    winners.set(position.user_id, (winners.get(position.user_id) ?? 0n) + amount);
  }
  return winners;
}

export async function applySettlement(deps: WagerModuleDeps, marketId: string): Promise<void> {
  if (await deps.db.hasSettlementApplied(marketId)) return;
  const outcome = await deps.db.getSettlementOutcome(marketId);
  if (outcome === null) return; // not settled yet — the sweeper will be back

  const positions = await deps.db.positionsForMarket(marketId);

  // Refund still-pending taps (anti-snipe window never cleared), everyone on
  // a void — the Rep rules — AND already-voided positions: unlike Rep, sol
  // stakes are deliberately NOT refunded at void_positions effect time (the
  // seam must never post lamports as Rep), so this is their only refund path.
  // The per-position idempotency key makes re-runs and overlaps safe.
  const pendingIds: string[] = [];
  for (const position of positions) {
    const refundable =
      outcome === 'void' || position.state === 'pending' || position.state === 'void';
    if (!refundable) continue;
    await deps.db.postWagerLedger({
      user_id: position.user_id,
      group_id: null,
      market_id: marketId,
      kind: 'refund',
      lamports: assertSafeLamports(position.stake, `position ${position.id}`),
      idempotency_key: WAGER_KEYS.refund(position.id),
    });
    if (position.state === 'pending') pendingIds.push(position.id);
  }
  if (pendingIds.length > 0) await deps.db.setPositionStates(pendingIds, 'void');

  const winners = computeWinnersLamports(positions, outcome);
  for (const [userId, lamports] of winners) {
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
    winners: winners.size,
    refunds: pendingIds.length,
  });
}

/** Chat receipt line — SOL amounts are chat-only, public receipts untouched. */
export async function settlementPayoutsLine(
  deps: WagerModuleDeps,
  marketId: string,
  outcome: WagerSettlementOutcome,
): Promise<string> {
  if (outcome === 'void') return WAGER_COPY.payoutsLineVoid();
  const positions = await deps.db.positionsForMarket(marketId);
  const winners = computeWinnersLamports(positions, outcome);
  if (winners.size === 0) return WAGER_COPY.payoutsLineNone();
  const parts: string[] = [];
  for (const [userId, lamports] of winners) {
    const name = (await deps.db.getUserName(userId)) ?? 'A winner';
    parts.push(WAGER_COPY.payoutPart(name, lamports));
  }
  return WAGER_COPY.payoutsLine(parts);
}

export interface SettlementSweeper {
  tick(): Promise<void>;
}

/** Re-runs applySettlement for settled/voided sol markets missing the marker. */
export function createSettlementSweeper(deps: WagerModuleDeps): SettlementSweeper {
  return {
    async tick(): Promise<void> {
      try {
        const marketIds = await deps.db.settledSolMarketsMissingApplied();
        for (const marketId of marketIds) {
          deps.log.info('wager_settlement_sweep', { marketId });
          await applySettlement(deps, marketId);
        }
      } catch (err) {
        deps.log.error('wager_settlement_sweeper_failed', { error: String(err) });
      }
    },
  };
}
