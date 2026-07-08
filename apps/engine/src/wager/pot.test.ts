import { describe, expect, it } from 'vitest';
import {
  computePots,
  fullMatchMultiplier,
  ratioMilli,
  settlementCredits,
} from './pot.js';
import type { WagerPositionRow, WagerPositionSide, WagerSettlementOutcome } from './port.js';

let seq = 0;
function position(
  side: WagerPositionSide,
  stake: number,
  state: WagerPositionRow['state'] = 'active',
  userId = 1,
): WagerPositionRow {
  seq += 1;
  return {
    id: `pos-${seq}`,
    market_id: 'm1',
    user_id: userId,
    side,
    stake,
    locked_multiplier: 2,
    state,
    placed_at_ms: 0,
  };
}

function sumStakes(positions: WagerPositionRow[]): bigint {
  return positions.reduce((total, p) => total + BigInt(p.stake), 0n);
}

function totalCredited(result: ReturnType<typeof settlementCredits>): bigint {
  let total = 0n;
  for (const refund of result.refunds) total += refund.lamports;
  for (const lamports of result.payouts.values()) total += lamports;
  return total;
}

describe('ratioMilli', () => {
  it('is AGAINST-lamports per 1000 FOR-lamports', () => {
    // p=0.5 → (0.5/0.5)*1000 = 1000
    expect(ratioMilli(0.5)).toBe(1000n);
    // p=0.61 → (0.39/0.61)*1000 ≈ 639
    expect(ratioMilli(0.61)).toBe(639n);
    // p=0.8 → (0.2/0.8)*1000 = 250
    expect(ratioMilli(0.8)).toBe(250n);
  });

  it('clamps to >= 1n as p → 1 (would otherwise divide by zero)', () => {
    // p=0.9995 → (0.0005/0.9995)*1000 ≈ 0.5 → rounds to 1 (clamp), not 0
    expect(ratioMilli(0.9995)).toBe(1n);
    expect(ratioMilli(0.99999)).toBe(1n);
    // Even at the practical ceiling the ratio never hits zero.
    expect(ratioMilli(0.999999)).toBeGreaterThanOrEqual(1n);
  });
});

describe('fullMatchMultiplier', () => {
  it('matches the plan example: p=0.61 → back ×1.64', () => {
    // (1000 + 639) / 1000 = 1.639
    expect(fullMatchMultiplier(0.61, 'back')).toBeCloseTo(1.639, 3);
    // (1000 + 639) / 639 ≈ 2.565
    expect(fullMatchMultiplier(0.61, 'doubt')).toBeCloseTo(2.565, 2);
  });
});

describe('computePots', () => {
  it('matches the smaller side at the feed ratio', () => {
    // p=0.5 → ratio 1000, so 1:1 matching.
    const pots = computePots(
      [position('back', 50_000_000), position('doubt', 30_000_000)],
      0.5,
    );
    expect(pots.forLamports).toBe(50_000_000n);
    expect(pots.againstLamports).toBe(30_000_000n);
    // AGAINST covers 30M FOR at 1:1; FOR is matched up to 30M.
    expect(pots.matchedFor).toBe(30_000_000n);
    expect(pots.matchedAgainst).toBe(30_000_000n);
    // matched (30M+30M) of total (80M) = 75%
    expect(pots.matchedPct).toBe(75);
  });

  it('is zero-matched when one side is empty', () => {
    const pots = computePots([position('back', 50_000_000)], 0.6);
    expect(pots.matchedFor).toBe(0n);
    expect(pots.matchedAgainst).toBe(0n);
    expect(pots.matchedPct).toBe(0);
  });
});

describe('settlementCredits — unit cases', () => {
  it('void refunds every stake in full', () => {
    const positions = [position('back', 50_000_000), position('doubt', 30_000_000)];
    const result = settlementCredits(positions, 'void', 0.5);
    expect(result.payouts.size).toBe(0);
    expect(totalCredited(result)).toBe(80_000_000n);
  });

  it('refunds everyone when no one took the other side', () => {
    const positions = [position('back', 50_000_000, 'active', 1)];
    const result = settlementCredits(positions, 'claim_won', 0.6);
    // Nothing matched → the backer just gets their stake back, no winnings.
    expect(result.payouts.get(1)).toBe(50_000_000n);
    expect(totalCredited(result)).toBe(50_000_000n);
  });

  it('pays the winner their stake plus the matched losing pot', () => {
    // p=0.5, 1:1. Back 40M vs Against 40M — fully matched.
    const back = position('back', 40_000_000, 'active', 1);
    const against = position('doubt', 40_000_000, 'active', 2);
    const result = settlementCredits([back, against], 'claim_won', 0.5);
    // Backer (winner) gets 40M stake + 40M forfeited = 80M; doubter forfeits all.
    expect(result.payouts.get(1)).toBe(80_000_000n);
    // Loser refund is the unmatched remainder — here zero (fully matched).
    expect(result.refunds.find((r) => r.positionId === against.id)).toBeUndefined();
    expect(totalCredited(result)).toBe(80_000_000n);
  });

  it('refunds the unmatched excess on the bigger side', () => {
    // p=0.5, 1:1. Back 60M vs Against 20M — only 20M each side matched.
    const result = settlementCredits(
      [position('back', 60_000_000, 'active', 1), position('doubt', 20_000_000, 'active', 2)],
      'claim_won',
      0.5,
    );
    // Winner: 60M stake back + 20M won = 80M.
    expect(result.payouts.get(1)).toBe(80_000_000n);
    // Loser forfeits their matched 20M → refund 0.
    expect(totalCredited(result)).toBe(80_000_000n);
  });

  it('flips pending positions to void and refunds them (their only refund path)', () => {
    const pending = position('back', 10_000_000, 'pending', 3);
    const result = settlementCredits(
      [position('back', 40_000_000, 'active', 1), position('doubt', 40_000_000, 'active', 2), pending],
      'claim_won',
      0.5,
    );
    expect(result.voidedPendingIds).toEqual([pending.id]);
    expect(result.refunds.find((r) => r.positionId === pending.id)?.lamports).toBe(10_000_000n);
  });

  it('aggregates multiple winning positions by user', () => {
    // Two back positions from the same user, both winning.
    const result = settlementCredits(
      [
        position('back', 20_000_000, 'active', 1),
        position('back', 20_000_000, 'active', 1),
        position('doubt', 40_000_000, 'active', 2),
      ],
      'claim_won',
      0.5,
    );
    // User 1: 40M staked + 40M forfeited pot = 80M, aggregated into one payout.
    expect(result.payouts.get(1)).toBe(80_000_000n);
    expect([...result.payouts.keys()]).toEqual([1]);
  });
});

// ── Seeded-random conservation property ────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('settlementCredits — conservation property (seeded random)', () => {
  const outcomes: WagerSettlementOutcome[] = ['claim_won', 'claim_lost', 'void'];
  const states: WagerPositionRow['state'][] = ['active', 'active', 'active', 'pending', 'void'];

  it('never pays out more than escrow, and leaves only flooring dust', () => {
    const rand = mulberry32(0xc0ffee);
    for (let iteration = 0; iteration < 4000; iteration += 1) {
      // p in (0.01, 0.99) — the mint path refuses degenerate quotes.
      const probability = 0.01 + rand() * 0.98;
      const count = 1 + Math.floor(rand() * 8);
      const positions: WagerPositionRow[] = [];
      for (let i = 0; i < count; i += 1) {
        const side: WagerPositionSide = rand() < 0.5 ? 'back' : 'doubt';
        // 0.001 .. 0.1 SOL in lamports.
        const stake = 1_000_000 + Math.floor(rand() * 99_000_000);
        const state = states[Math.floor(rand() * states.length)]!;
        const userId = 1 + Math.floor(rand() * 3);
        positions.push(position(side, stake, state, userId));
      }
      const outcome = outcomes[Math.floor(rand() * outcomes.length)]!;
      const result = settlementCredits(positions, outcome, probability);

      const escrow = sumStakes(positions);
      const credited = totalCredited(result);
      const context = `iter=${iteration} p=${probability} outcome=${outcome} n=${count}`;

      // Conservation: never create lamports.
      expect(credited, `overpaid: ${context}`).toBeLessThanOrEqual(escrow);
      // Dust bound: the only shortfall is per-winner flooring (< #positions).
      expect(escrow - credited, `too much dust: ${context}`).toBeLessThanOrEqual(BigInt(count));
      // No negative credits.
      for (const refund of result.refunds) {
        expect(refund.lamports, `negative refund: ${context}`).toBeGreaterThan(0n);
      }
      for (const lamports of result.payouts.values()) {
        expect(lamports, `negative payout: ${context}`).toBeGreaterThan(0n);
      }
    }
  });
});
