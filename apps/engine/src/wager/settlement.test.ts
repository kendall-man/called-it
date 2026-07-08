import { describe, expect, it } from 'vitest';
import {
  applySettlement,
  computeWinnersLamports,
  createSettlementSweeper,
  payoutLamports,
  settlementPayoutsLine,
} from './settlement.js';
import { WAGER_KEYS } from './constants.js';
import { makeFakeDeps } from './fakes.js';
import type { WagerPositionRow } from './port.js';

describe('payoutLamports quantization', () => {
  // stake lamports, locked multiplier, expected floor payout at MULT_SCALE
  const vectors: Array<[bigint, number, bigint]> = [
    [10_000_000n, 1.85, 18_500_000n],
    [10_000_000n, 1.02, 10_200_000n],
    [100_000_000n, 25, 2_500_000_000n],
    // floor behavior: 33_333_333 × 1333 / 1000 = 44_433_332.889 → 44_433_332
    [33_333_333n, 1.333, 44_433_332n],
    // sub-milli remainder floors away entirely
    [1n, 1.005, 1n],
    [999n, 1.001, 999n],
    // multiplier itself rounds to milli-units before the bigint math
    [7n, 3.14159, 21n], // round(3141.59)=3142 → floor(7×3142/1000)=21
    [1_000n, 1.0004, 1_000n], // round(1000.4)=1000 → ×1.000
    [1_000n, 1.0006, 1_001n], // round(1000.6)=1001 → floor(1001)
    [0n, 5, 0n],
  ];

  it.each(vectors)('stake %s × %s → %s lamports', (stake, multiplier, expected) => {
    expect(payoutLamports(stake, multiplier)).toBe(expected);
  });

  it('never rounds a payout up past the exact product', () => {
    for (const stake of [1n, 3n, 7n, 999_999_999n]) {
      for (const multiplier of [1.02, 1.5, 2.33, 24.99]) {
        const multMilli = BigInt(Math.round(multiplier * 1000));
        const exactMilli = stake * multMilli;
        expect(payoutLamports(stake, multiplier) * 1000n).toBeLessThanOrEqual(exactMilli);
      }
    }
  });
});

function position(overrides: Partial<WagerPositionRow>): WagerPositionRow {
  return {
    id: overrides.id ?? 'p1',
    market_id: overrides.market_id ?? 'm1',
    user_id: overrides.user_id ?? 1,
    side: overrides.side ?? 'back',
    stake: overrides.stake ?? 10_000_000,
    locked_multiplier: overrides.locked_multiplier ?? 2,
    state: overrides.state ?? 'active',
    placed_at_ms: overrides.placed_at_ms ?? 0,
  };
}

describe('computeWinnersLamports', () => {
  it('pays only active positions on the winning side, summed per user', () => {
    const winners = computeWinnersLamports(
      [
        position({ id: 'a', user_id: 1, side: 'back', stake: 10_000_000, locked_multiplier: 2 }),
        position({ id: 'b', user_id: 1, side: 'back', stake: 50_000_000, locked_multiplier: 1.5 }),
        position({ id: 'c', user_id: 2, side: 'doubt', stake: 10_000_000 }),
        position({ id: 'd', user_id: 3, side: 'back', state: 'pending' }),
        position({ id: 'e', user_id: 4, side: 'back', state: 'void' }),
      ],
      'claim_won',
    );
    expect(winners.get(1)).toBe(20_000_000n + 75_000_000n);
    expect(winners.has(2)).toBe(false);
    expect(winners.has(3)).toBe(false); // pending never pays
    expect(winners.has(4)).toBe(false);
  });

  it('claim_lost pays the doubting side', () => {
    const winners = computeWinnersLamports(
      [
        position({ id: 'a', user_id: 1, side: 'back' }),
        position({ id: 'b', user_id: 2, side: 'doubt', stake: 10_000_000, locked_multiplier: 3 }),
      ],
      'claim_lost',
    );
    expect([...winners.entries()]).toEqual([[2, 30_000_000n]]);
  });

  it('void pays nobody', () => {
    expect(computeWinnersLamports([position({})], 'void').size).toBe(0);
  });

  it('rejects unsafe stake integers loudly', () => {
    expect(() =>
      computeWinnersLamports([position({ stake: 2 ** 53 })], 'claim_won'),
    ).toThrow(/safe integer/);
  });
});

describe('applySettlement', () => {
  it('pays winners, refunds pending, voids the pending rows, stamps the marker', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    const winner = db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 10_000_000, locked_multiplier: 2 });
    const loser = db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 50_000_000 });
    const pending = db.seedPosition({ market_id: 'm1', user_id: 3, side: 'back', stake: 10_000_000, state: 'pending' });
    const voided = db.seedPosition({ market_id: 'm1', user_id: 4, side: 'back', state: 'void' });

    await applySettlement(deps, 'm1');

    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', 1))?.lamports).toBe(20_000_000n);
    expect(db.ledgerByKey(WAGER_KEYS.refund(pending.id))?.lamports).toBe(10_000_000n);
    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', 2))).toBeUndefined();
    expect(db.ledgerByKey(WAGER_KEYS.refund(loser.id))).toBeUndefined();
    // Delay-snipe-voided sol stakes are NOT refunded at effect time (the seam
    // must never post lamports as Rep) — settlement is their only refund path.
    expect(db.ledgerByKey(WAGER_KEYS.refund(voided.id))?.lamports).toBe(10_000_000n);
    expect(pending.state).toBe('void');
    expect(winner.state).toBe('active');
    expect(db.applied.has('m1')).toBe(true);
  });

  it('is idempotent — a second run adds zero ledger entries', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back' });
    db.seedPosition({ market_id: 'm1', user_id: 2, side: 'back', state: 'pending' });

    await applySettlement(deps, 'm1');
    const after = db.ledger.length;
    await applySettlement(deps, 'm1');
    expect(db.ledger.length).toBe(after);
  });

  it('re-run converges even when the marker write crashed the first time', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back' });
    await applySettlement(deps, 'm1');
    const after = db.ledger.length;
    // Simulate the crash window: the money moved but the marker never landed.
    db.applied.delete('m1');
    await applySettlement(deps, 'm1');
    expect(db.ledger.length).toBe(after); // idempotency keys absorbed the rerun
    expect(db.applied.has('m1')).toBe(true);
  });

  it('void refunds every position (including already-voided) and pays nobody', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'void');
    const active = db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 10_000_000 });
    const pending = db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 50_000_000, state: 'pending' });
    const voided = db.seedPosition({ market_id: 'm1', user_id: 3, state: 'void' });

    await applySettlement(deps, 'm1');

    expect(db.ledgerByKey(WAGER_KEYS.refund(active.id))?.lamports).toBe(10_000_000n);
    expect(db.ledgerByKey(WAGER_KEYS.refund(pending.id))?.lamports).toBe(50_000_000n);
    expect(db.ledgerByKey(WAGER_KEYS.refund(voided.id))?.lamports).toBe(10_000_000n);
    expect(db.ledger.filter((entry) => entry.kind === 'payout')).toHaveLength(0);
  });

  it('does nothing for an unsettled market', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedPosition({ market_id: 'm1' });
    await applySettlement(deps, 'm1');
    expect(db.ledger).toHaveLength(0);
    expect(db.applied.size).toBe(0);
  });
});

describe('settlementPayoutsLine', () => {
  it('names each winner with exact SOL and a devnet stamp', async () => {
    const { deps, db } = makeFakeDeps();
    db.users.set(1, 'Sana');
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 10_000_000, locked_multiplier: 1.85 });
    const line = await settlementPayoutsLine(deps, 'm1', 'claim_won');
    expect(line).toContain('Sana');
    expect(line).toContain('0.0185 SOL');
    expect(line).toContain('(devnet)');
  });

  it('void and no-winner lines are distinct', async () => {
    const { deps } = makeFakeDeps();
    const voidLine = await settlementPayoutsLine(deps, 'm1', 'void');
    const noneLine = await settlementPayoutsLine(deps, 'm1', 'claim_won');
    expect(voidLine).not.toBe(noneLine);
    expect(voidLine).toContain('(devnet)');
    expect(noneLine).toContain('(devnet)');
  });
});

describe('settlement sweeper', () => {
  it('applies any settled sol market missing the marker, then goes quiet', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.settlements.set('m2', 'void');
    db.applied.add('m2');
    const winner = db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back' });

    const sweeper = createSettlementSweeper(deps);
    await sweeper.tick();
    expect(db.applied.has('m1')).toBe(true);
    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', winner.user_id))).toBeDefined();

    const after = db.ledger.length;
    await sweeper.tick();
    expect(db.ledger.length).toBe(after);
  });
});
