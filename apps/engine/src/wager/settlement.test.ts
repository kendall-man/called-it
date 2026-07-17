import { describe, expect, it } from 'vitest';
import {
  applySettlement,
  createSettlementSweeper,
  settlementPayoutsLine,
} from './settlement.js';
import { WAGER_KEYS } from './constants.js';
import { makeFakeDeps } from './fakes.js';

// p=0.5 → ratio 1000 → 1:1 peer matching, so the expected numbers stay round.
const EVEN = 0.5;

describe('applySettlement — peer-matched', () => {
  it('pays the winner stake + matched losing pot, refunds pending, voids pending, stamps marker', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', EVEN);
    const winner = db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 40_000_000 });
    const loser = db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 40_000_000 });
    const pending = db.seedPosition({ market_id: 'm1', user_id: 3, side: 'back', stake: 10_000_000, state: 'pending' });
    const voided = db.seedPosition({ market_id: 'm1', user_id: 4, side: 'back', stake: 10_000_000, state: 'void' });

    await applySettlement(deps, 'm1');

    // Back wins: 40M matched 1:1, so the winner gets 40M stake + 40M forfeited.
    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', 1))?.lamports).toBe(80_000_000n);
    // Loser was fully matched → forfeits everything → no remainder refund.
    expect(db.ledgerByKey(WAGER_KEYS.refund(loser.id))).toBeUndefined();
    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', 2))).toBeUndefined();
    // Pending + already-voided sol stakes are only ever refunded here.
    expect(db.ledgerByKey(WAGER_KEYS.refund(pending.id))?.lamports).toBe(10_000_000n);
    expect(db.ledgerByKey(WAGER_KEYS.refund(voided.id))?.lamports).toBe(10_000_000n);
    expect(pending.state).toBe('void');
    expect(winner.state).toBe('active');
    expect(db.applied.has('m1')).toBe(true);
  });

  it('refunds the unmatched excess on the heavier side', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', EVEN);
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 60_000_000 });
    const loser = db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 20_000_000 });

    await applySettlement(deps, 'm1');

    // Only 20M each side matched: winner gets 60M back + 20M won.
    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', 1))?.lamports).toBe(80_000_000n);
    // Loser fully matched (20M) → no remainder.
    expect(db.ledgerByKey(WAGER_KEYS.refund(loser.id))).toBeUndefined();
  });

  it('refunds everyone when no one took the other side', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', 0.6);
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 50_000_000 });

    await applySettlement(deps, 'm1');
    // Nothing matched → the backer's payout is just their own stake back.
    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', 1))?.lamports).toBe(50_000_000n);
  });

  it('is idempotent — a second run adds zero ledger entries', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', EVEN);
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 40_000_000 });
    db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 40_000_000 });

    await applySettlement(deps, 'm1');
    const after = db.ledger.length;
    await applySettlement(deps, 'm1');
    expect(db.ledger.length).toBe(after);
  });

  it('re-run converges even when the marker write crashed the first time', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', EVEN);
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back' });
    await applySettlement(deps, 'm1');
    const after = db.ledger.length;
    db.applied.delete('m1'); // money moved but the marker never landed
    await applySettlement(deps, 'm1');
    expect(db.ledger.length).toBe(after);
    expect(db.applied.has('m1')).toBe(true);
  });

  it('void refunds every position (including already-voided) and pays nobody', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'void');
    db.seedMarketProbability('m1', EVEN);
    const active = db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 10_000_000 });
    const pending = db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 50_000_000, state: 'pending' });
    const voided = db.seedPosition({ market_id: 'm1', user_id: 3, state: 'void', stake: 10_000_000 });

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

  it('refuses to settle without the market probability (never guesses the ratio)', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won'); // settled, but no probability seeded
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back' });
    await applySettlement(deps, 'm1');
    expect(db.ledger).toHaveLength(0);
    expect(db.applied.has('m1')).toBe(false);
  });
});

describe('settlementPayoutsLine', () => {
  it('names each winner with exact SOL', async () => {
    const { deps, db } = makeFakeDeps();
    db.users.set(1, 'Sana');
    db.seedMarketProbability('m1', EVEN);
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 10_000_000 });
    db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 10_000_000 });
    const line = await settlementPayoutsLine(deps, 'm1', 'claim_won');
    expect(line).toContain('Sana');
    // 10M stake + 10M matched-and-won = 20M = 0.02 SOL.
    expect(line).toContain('0.02 SOL');
  });

  it('void and no-winner lines are distinct', async () => {
    const { deps } = makeFakeDeps();
    const voidLine = await settlementPayoutsLine(deps, 'm1', 'void');
    const noneLine = await settlementPayoutsLine(deps, 'm1', 'claim_won');
    expect(voidLine).not.toBe(noneLine);
  });
});

describe('settlement sweeper', () => {
  it('applies any settled sol market missing the marker, then goes quiet', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', 0.6);
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
