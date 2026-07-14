import { U64_MAX, assertInteger, assertU64 } from './codec.js';
import type { PositionSide, SettlementOutcome } from './domain.js';

const SCALE = 1_000n;
const U128_MAX = (1n << 128n) - 1n;

export type EscrowMathPositionState = 'active' | 'pending' | 'invalidated';
export interface EscrowMathPosition {
  readonly id: string;
  readonly owner: string;
  readonly side: PositionSide;
  readonly state: EscrowMathPositionState;
  readonly amount: bigint;
}

export interface EscrowPots {
  readonly backAmount: bigint;
  readonly doubtAmount: bigint;
  readonly matchedBack: bigint;
  readonly matchedDoubt: bigint;
}

export interface EscrowRefund {
  readonly positionId: string;
  readonly owner: string;
  readonly amount: bigint;
}

export interface EscrowSettlement {
  readonly refunds: readonly EscrowRefund[];
  readonly payouts: ReadonlyMap<string, bigint>;
  readonly pots: EscrowPots;
  readonly totalDeposits: bigint;
  readonly totalEntitlement: bigint;
  readonly dust: bigint;
}

function checkedAddU64(left: bigint, right: bigint, name: string): bigint {
  const result = left + right;
  if (result < 0n || result > U64_MAX) throw new RangeError(`${name} exceeds u64`);
  return result;
}

function checkedMulU128(left: bigint, right: bigint, name: string): bigint {
  const result = left * right;
  if (result < 0n || result > U128_MAX) throw new RangeError(`${name} exceeds u128`);
  return result;
}

function minBigint(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

/** Exact compatibility helper for the current JS engine's Math.round path. */
export function ratioMilliFromProbability(probability: number): bigint {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    throw new RangeError('probability must be a finite number strictly between zero and one');
  }
  const ratio = ((1 - probability) / probability) * Number(SCALE);
  const rounded = Math.round(ratio);
  if (!Number.isSafeInteger(rounded)) {
    throw new RangeError(`probability ${probability} yields an unsafe ratio`);
  }
  return rounded < 1 ? 1n : BigInt(rounded);
}

/** Quantize an off-chain quote exactly once before constructing Escrow V1 data. */
export function quantizeProbabilityPpm(probability: number): number {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    throw new RangeError('probability must be a finite number strictly between zero and one');
  }
  return assertInteger(Math.round(probability * 1_000_000), 'probability PPM', 1, 999_999);
}

/** Canonical protocol helper: round the exact PPM rational, half upward. */
export function ratioMilliFromProbabilityPpm(probabilityPpm: number): number {
  assertInteger(probabilityPpm, 'probability PPM', 1, 999_999);
  const probability = BigInt(probabilityPpm);
  const numerator = (1_000_000n - probability) * SCALE;
  const rounded = (numerator + (probability / 2n)) / probability;
  return Number(rounded < 1n ? 1n : rounded);
}

function validatePositions(positions: readonly EscrowMathPosition[]): bigint {
  const ids = new Set<string>();
  let total = 0n;
  for (const position of positions) {
    if (position.id.length === 0 || ids.has(position.id)) throw new Error('position IDs must be nonempty and unique');
    if (position.owner.length === 0) throw new Error('position owner must be nonempty');
    ids.add(position.id);
    assertU64(position.amount, `position ${position.id} amount`);
    if (position.amount === 0n) throw new RangeError(`position ${position.id} amount must be positive`);
    total = checkedAddU64(total, position.amount, 'total deposits');
  }
  return total;
}

export function computePots(
  positions: readonly EscrowMathPosition[],
  ratioMilli: bigint,
): EscrowPots {
  validatePositions(positions);
  assertU64(ratioMilli, 'ratio milli');
  if (ratioMilli === 0n) throw new RangeError('ratio milli must be positive');
  let backAmount = 0n;
  let doubtAmount = 0n;
  for (const position of positions) {
    if (position.state !== 'active') continue;
    if (position.side === 'back') {
      backAmount = checkedAddU64(backAmount, position.amount, 'active back total');
    } else {
      doubtAmount = checkedAddU64(doubtAmount, position.amount, 'active doubt total');
    }
  }
  const matchedBack = minBigint(
    backAmount,
    checkedMulU128(doubtAmount, SCALE, 'matched back numerator') / ratioMilli,
  );
  const matchedDoubt = minBigint(
    doubtAmount,
    checkedMulU128(matchedBack, ratioMilli, 'matched doubt numerator') / SCALE,
  );
  return { backAmount, doubtAmount, matchedBack, matchedDoubt };
}

export function settlePositions(
  positions: readonly EscrowMathPosition[],
  outcome: SettlementOutcome,
  ratioMilli: bigint,
): EscrowSettlement {
  const totalDeposits = validatePositions(positions);
  const refunds: EscrowRefund[] = [];
  const active: EscrowMathPosition[] = [];
  for (const position of positions) {
    if (outcome === 'void' || position.state !== 'active') {
      refunds.push({ positionId: position.id, owner: position.owner, amount: position.amount });
    } else {
      active.push(position);
    }
  }

  const pots = computePots(active, ratioMilli);
  const payouts = new Map<string, bigint>();
  if (outcome !== 'void') {
    const winningSide: PositionSide = outcome === 'claim_won' ? 'back' : 'doubt';
    const backWins = winningSide === 'back';
    const winningStakes = backWins ? pots.backAmount : pots.doubtAmount;
    const losingStakes = backWins ? pots.doubtAmount : pots.backAmount;
    const matchedLosing = backWins ? pots.matchedDoubt : pots.matchedBack;
    let forfeitedPot = 0n;

    for (const position of active) {
      if (position.side === winningSide) continue;
      const forfeit = losingStakes === 0n
        ? 0n
        : checkedMulU128(position.amount, matchedLosing, 'loser forfeit numerator') / losingStakes;
      forfeitedPot = checkedAddU64(forfeitedPot, forfeit, 'forfeited pot');
      const refund = position.amount - forfeit;
      if (refund > 0n) refunds.push({ positionId: position.id, owner: position.owner, amount: refund });
    }

    for (const position of active) {
      if (position.side !== winningSide) continue;
      const winnings = winningStakes === 0n
        ? 0n
        : checkedMulU128(position.amount, forfeitedPot, 'winner payout numerator') / winningStakes;
      const payout = checkedAddU64(position.amount, winnings, 'position payout');
      payouts.set(
        position.owner,
        checkedAddU64(payouts.get(position.owner) ?? 0n, payout, 'owner payout'),
      );
    }
  }

  const refundTotal = refunds.reduce((total, refund) => checkedAddU64(total, refund.amount, 'refund total'), 0n);
  const payoutTotal = [...payouts.values()].reduce((total, payout) => checkedAddU64(total, payout, 'payout total'), 0n);
  const totalEntitlement = checkedAddU64(refundTotal, payoutTotal, 'total entitlement');
  if (totalEntitlement > totalDeposits) throw new Error('settlement entitlements exceed deposits');
  return {
    refunds,
    payouts,
    pots,
    totalDeposits,
    totalEntitlement,
    dust: totalDeposits - totalEntitlement,
  };
}

export function settlePositionsForProbability(
  positions: readonly EscrowMathPosition[],
  outcome: SettlementOutcome,
  probability: number,
): EscrowSettlement {
  return settlePositions(positions, outcome, ratioMilliFromProbability(probability));
}
