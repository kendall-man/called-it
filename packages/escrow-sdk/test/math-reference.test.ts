import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ratioMilliFromProbability,
  ratioMilliFromProbabilityPpm,
  quantizeProbabilityPpm,
  settlePositions,
  settlePositionsForProbability,
  type EscrowMathPosition,
} from '../src/math-reference.js';
import {
  ratioMilli as engineRatioMilli,
  settlementCredits as engineSettlementCredits,
} from '../../../apps/engine/src/wager/pot.js';

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

interface PayoutGoldenVector {
  ratio_milli: string;
  outcome: 'claim_won' | 'claim_lost' | 'void';
  positions: Array<{
    id: string;
    owner: string;
    side: 'back' | 'doubt';
    state: 'active' | 'pending' | 'invalidated';
    amount: string;
  }>;
  expected: {
    matched_back: string;
    matched_doubt: string;
    refunds: Array<{ position_id: string; owner: string; amount: string }>;
    payouts: Array<{ owner: string; amount: string }>;
    total_deposits: string;
    total_entitlement: string;
    dust: string;
  };
}

const payoutGolden = JSON.parse(readFileSync(
  new URL('../vectors/payout-v1.json', import.meta.url),
  'utf8',
)) as PayoutGoldenVector;

describe('checked payout math reference', () => {
  it('preserves the existing floating-point ratio helper', () => {
    for (const probability of [0.001, 0.00512, 0.25, 0.5, 0.62, 0.9999]) {
      expect(ratioMilliFromProbability(probability)).toBe(engineRatioMilli(probability));
    }
  });

  it('defines integer PPM rounding without inheriting binary float drift', () => {
    expect(quantizeProbabilityPpm(0.62)).toBe(620_000);
    expect(ratioMilliFromProbabilityPpm(620_000)).toBe(613);
    expect(ratioMilliFromProbabilityPpm(5_120)).toBe(194_313);
    expect(ratioMilliFromProbability(0.00512)).toBe(194_312n);
    const ppm = 333_333n;
    const numerator = (1_000_000n - ppm) * 1_000n;
    expect(ratioMilliFromProbabilityPpm(Number(ppm)))
      .toBe(Number((numerator + (ppm / 2n)) / ppm));
  });

  it('handles partial matching, pending refunds, and floor dust', () => {
    const positions: EscrowMathPosition[] = payoutGolden.positions.map((position) => ({
      ...position,
      amount: BigInt(position.amount),
    }));
    const result = settlePositions(positions, payoutGolden.outcome, BigInt(payoutGolden.ratio_milli));
    expect(result.pots.matchedBack).toBe(BigInt(payoutGolden.expected.matched_back));
    expect(result.pots.matchedDoubt).toBe(BigInt(payoutGolden.expected.matched_doubt));
    expect(result.payouts).toEqual(new Map(
      payoutGolden.expected.payouts.map(({ owner, amount }) => [owner, BigInt(amount)]),
    ));
    expect(result.refunds).toEqual(payoutGolden.expected.refunds.map((refund) => ({
      positionId: refund.position_id,
      owner: refund.owner,
      amount: BigInt(refund.amount),
    })));
    expect(result.totalDeposits).toBe(BigInt(payoutGolden.expected.total_deposits));
    expect(result.totalEntitlement).toBe(BigInt(payoutGolden.expected.total_entitlement));
    expect(result.dust).toBe(BigInt(payoutGolden.expected.dust));
  });

  it('matches the current engine and conserves deposits over seeded random markets', () => {
    const next = random(0xc011ed17);
    for (let market = 0; market < 4_000; market += 1) {
      const probability = (1 + Math.floor(next() * 999_998)) / 1_000_000;
      const outcome = next() < 0.49 ? 'claim_won' : next() < 0.96 ? 'claim_lost' : 'void';
      const count = 1 + Math.floor(next() * 12);
      const positions: EscrowMathPosition[] = [];
      const enginePositions = [];
      for (let index = 0; index < count; index += 1) {
        const amount = BigInt(1 + Math.floor(next() * 1_000_000));
        const stateRoll = next();
        const state = stateRoll < 0.75 ? 'active' : stateRoll < 0.9 ? 'pending' : 'invalidated';
        const side = next() < 0.5 ? 'back' : 'doubt';
        const id = `${market}:${index}`;
        const owner = String(index + 1);
        positions.push({ id, owner, side, state, amount });
        enginePositions.push({
          id,
          market_id: `market-${market}`,
          user_id: index + 1,
          side,
          stake: Number(amount),
          state: state === 'invalidated' ? 'void' : state,
          locked_multiplier: 1,
          locked_probability: probability,
          locked_odds_message_id: null,
          locked_odds_ts: null,
          created_at: '2026-01-01T00:00:00.000Z',
        });
      }

      const sdk = settlePositionsForProbability(positions, outcome, probability);
      const engine = engineSettlementCredits(enginePositions, outcome, probability);
      expect(sdk.refunds.map((item) => [item.positionId, item.owner, item.amount]))
        .toEqual(engine.refunds.map((item) => [item.positionId, String(item.userId), item.lamports]));
      expect(sdk.payouts).toEqual(new Map(
        [...engine.payouts].map(([owner, amount]) => [String(owner), amount]),
      ));
      const deposits = positions.reduce((sum, item) => sum + item.amount, 0n);
      expect(sdk.totalEntitlement + sdk.dust).toBe(deposits);
      expect(sdk.dust).toBeGreaterThanOrEqual(0n);
    }
  });

  it('rejects negative, zero, and overflow-prone values', () => {
    expect(() => settlePositions([
      { id: 'bad', owner: '1', side: 'back', state: 'active', amount: -1n },
    ], 'claim_won', 1_000n)).toThrow(/u64/);
    expect(() => settlePositions([
      { id: 'zero', owner: '1', side: 'back', state: 'active', amount: 0n },
    ], 'claim_won', 1_000n)).toThrow(/positive/);
    expect(() => settlePositions([], 'claim_won', 0n)).toThrow(/positive/);
    expect(() => settlePositions([
      { id: 'too-large', owner: '1', side: 'back', state: 'active', amount: 1n << 64n },
    ], 'claim_won', 1_000n)).toThrow(/u64/);
  });
});
