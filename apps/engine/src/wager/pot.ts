/**
 * Peer-matched pot math (the broker model). The treasury only ESCROWS; a
 * claim's FOR pot and AGAINST pot settle against each other at the
 * feed-locked ratio, so total payouts are ALWAYS bounded by the total
 * escrowed stakes — treasury risk is structurally zero. Per-flooring dust
 * stays in the treasury.
 *
 * Feed price `p = market.quote_probability` (locked at mint; the mint path
 * refuses degenerate p via isDegenerateQuote). Ratio
 * `R_milli = round((1−p)/p × MULT_SCALE)` = AGAINST lamports needed to fully
 * cover MULT_SCALE FOR lamports. All lamports are bigint with floor division.
 */

import { WAGER_TUNABLES } from './constants.js';
import { assertSafeLamports } from './format.js';
import type { WagerPositionRow, WagerPositionSide, WagerSettlementOutcome } from './port.js';

const SCALE = BigInt(WAGER_TUNABLES.MULT_SCALE); // 1000n

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * AGAINST-lamports per MULT_SCALE FOR-lamports, from the feed probability.
 * Clamped to >= 1n because p ≥ 0.9995 rounds (1−p)/p×MULT_SCALE to 0, which
 * would divide-by-zero downstream. The safe-integer assert guards the float
 * round exactly like `multMilli` in the old payout path.
 */
export function ratioMilli(probability: number): bigint {
  const ratio = ((1 - probability) / probability) * WAGER_TUNABLES.MULT_SCALE;
  const rounded = Math.round(ratio);
  if (!Number.isSafeInteger(rounded)) {
    throw new Error(`ratioMilli: probability ${probability} yields unsafe ratio ${ratio}`);
  }
  return rounded < 1 ? 1n : BigInt(rounded);
}

/**
 * Full-match multiplier for the card ("pays up to ×M if fully matched"),
 * derived from the ratio — NOT the stored locked_multiplier (which is
 * MIN/MAX-clamped and over-promises ≤1% near p=1).
 */
export function fullMatchMultiplier(probability: number, side: WagerPositionSide): number {
  const rMilli = ratioMilli(probability);
  // back: stake × (SCALE + R_milli) / SCALE ; doubt: stake × (SCALE + R_milli) / R_milli
  const numerator = Number(SCALE + rMilli);
  return side === 'back' ? numerator / Number(SCALE) : numerator / Number(rMilli);
}

export interface Pots {
  /** Σ back-side stakes (lamports) over the given positions. */
  forLamports: bigint;
  /** Σ doubt-side stakes (lamports) over the given positions. */
  againstLamports: bigint;
  /** Lamports of the FOR pot covered by the AGAINST pot at the ratio. */
  matchedFor: bigint;
  /** Lamports of the AGAINST pot covered by the FOR pot. */
  matchedAgainst: bigint;
  /** 0..100 — matched fraction of the total staked pot (for the card). */
  matchedPct: number;
}

/**
 * Pots over the GIVEN positions. The CALLER filters: active-only for
 * settlement (pending/void never enter the matched pool), non-void for the
 * card tally (so a fresh in-play tap shows immediately, gotcha #7).
 */
export function computePots(positions: WagerPositionRow[], probability: number): Pots {
  const rMilli = ratioMilli(probability);
  let forLamports = 0n;
  let againstLamports = 0n;
  for (const position of positions) {
    const stake = assertSafeLamports(position.stake, `position ${position.id}`);
    if (position.side === 'back') forLamports += stake;
    else againstLamports += stake;
  }
  // AGAINST covers (against × SCALE / R_milli) FOR lamports; FOR is matched up
  // to that. matchedAgainst is the AGAINST that actually backs matchedFor.
  const matchedFor = minBig(forLamports, (againstLamports * SCALE) / rMilli);
  const matchedAgainst = minBig(againstLamports, (matchedFor * rMilli) / SCALE);
  const totalPot = forLamports + againstLamports;
  const matchedPct =
    totalPot === 0n ? 0 : Number(((matchedFor + matchedAgainst) * 100n) / totalPot);
  return { forLamports, againstLamports, matchedFor, matchedAgainst, matchedPct };
}

export interface SettlementCredits {
  /** Per-position refunds: full for pending/void, unmatched remainder for losers. */
  refunds: Array<{ positionId: string; userId: number; lamports: bigint }>;
  /** Per-user winnings: own stake back + pro-rata share of the forfeited pot. */
  payouts: Map<number, bigint>;
  /** Pending position ids flipped → void (settlement is their only refund path). */
  voidedPendingIds: string[];
  /** Pots over the active set (for logging/receipt context). */
  pots: Pots;
}

/**
 * The whole peer-matched settlement, as a pure function. Conservation
 * (property-tested): Σ(all refunds + all payouts) ≤ Σ(all escrowed stakes);
 * the flooring shortfall (≤ #positions lamports) stays in the treasury.
 */
export function settlementCredits(
  positions: WagerPositionRow[],
  outcome: WagerSettlementOutcome,
  probability: number,
): SettlementCredits {
  const refunds: SettlementCredits['refunds'] = [];
  const payouts = new Map<number, bigint>();
  const voidedPendingIds: string[] = [];

  // 1. Full refunds — void outcome, or a pending/void position (its ONLY
  // refund path; unlike Rep, sol stakes are never refunded at void-effect time).
  const active: WagerPositionRow[] = [];
  for (const position of positions) {
    const fullRefund =
      outcome === 'void' || position.state === 'pending' || position.state === 'void';
    if (fullRefund) {
      const stake = assertSafeLamports(position.stake, `position ${position.id}`);
      refunds.push({ positionId: position.id, userId: position.user_id, lamports: stake });
      if (position.state === 'pending') voidedPendingIds.push(position.id);
      continue;
    }
    active.push(position);
  }

  const pots = computePots(active, probability);
  if (outcome === 'void') return { refunds, payouts, voidedPendingIds, pots };

  const winningSide: WagerPositionSide = outcome === 'claim_won' ? 'back' : 'doubt';
  const forWins = winningSide === 'back';
  const winningStakes = forWins ? pots.forLamports : pots.againstLamports; // S_w
  const losingStakes = forWins ? pots.againstLamports : pots.forLamports; // S_l
  const matchedLosing = forWins ? pots.matchedAgainst : pots.matchedFor; // matched_l ≤ S_l

  // 2. Losing side — forfeit its matched fraction, refund the unmatched rest.
  let forfeitedPot = 0n;
  for (const position of active) {
    if (position.side === winningSide) continue;
    const stake = assertSafeLamports(position.stake, `position ${position.id}`);
    const forfeit = losingStakes > 0n ? (stake * matchedLosing) / losingStakes : 0n; // ≤ stake
    forfeitedPot += forfeit;
    const refund = stake - forfeit;
    if (refund > 0n) {
      refunds.push({ positionId: position.id, userId: position.user_id, lamports: refund });
    }
  }

  // 3. Winning side — full stake back + pro-rata share of the forfeited pot.
  for (const position of active) {
    if (position.side !== winningSide) continue;
    const stake = assertSafeLamports(position.stake, `position ${position.id}`);
    const winnings = winningStakes > 0n ? (stake * forfeitedPot) / winningStakes : 0n;
    payouts.set(position.user_id, (payouts.get(position.user_id) ?? 0n) + stake + winnings);
  }

  return { refunds, payouts, voidedPendingIds, pots };
}
