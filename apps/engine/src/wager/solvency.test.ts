import { describe, expect, it } from 'vitest';
import { createSolvencyMonitor, escrowedLamports } from './solvency.js';
import { SOLVENCY_PAUSE_REASON_PREFIX } from './constants.js';
import { makeFakeDeps } from './fakes.js';
import type { WagerPositionRow } from './port.js';

function position(overrides: Partial<WagerPositionRow>): WagerPositionRow {
  return {
    id: overrides.id ?? 'p1',
    market_id: overrides.market_id ?? 'm1',
    user_id: overrides.user_id ?? 1,
    side: overrides.side ?? 'back',
    stake: overrides.stake ?? 100,
    locked_multiplier: overrides.locked_multiplier ?? 2,
    state: overrides.state ?? 'active',
    placed_at_ms: 0,
  };
}

describe('escrowedLamports', () => {
  it('is zero with no positions', () => {
    expect(escrowedLamports([])).toBe(0n);
  });

  it('sums non-void stakes (pending counts — it may activate)', () => {
    const total = escrowedLamports([
      position({ id: 'a', stake: 100 }),
      position({ id: 'b', stake: 50, state: 'pending' }),
      position({ id: 'c', stake: 999, state: 'void' }),
    ]);
    expect(total).toBe(150n);
  });

  it('rejects unsafe stake integers loudly', () => {
    expect(() => escrowedLamports([position({ stake: 2 ** 53 })])).toThrow(/safe integer/);
  });
});

describe('solvency monitor', () => {
  it('healthy book: leaves the breaker alone and posts nothing', async () => {
    const { deps, db, chain, poster } = makeFakeDeps({ opsChatId: 777 });
    db.seedBalance(1, 1_000_000_000n);
    chain.treasuryLamports = 10_000_000_000n;
    await createSolvencyMonitor(deps).tick();
    expect(db.status.paused).toBe(false);
    expect(poster.posts).toHaveLength(0);
  });

  it('violation: persists the pause and alerts ops (no auto-airdrop)', async () => {
    const { deps, db, chain, poster } = makeFakeDeps({ opsChatId: 777 });
    db.seedBalance(1, 2_000_000_000n); // ledger owes 2 SOL
    chain.treasuryLamports = 1_000_000_000n; // holds only 1 SOL
    db.openSolMarkets = ['m1'];
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 100_000_000 });

    await createSolvencyMonitor(deps).tick();

    // required = ledger 2 SOL + escrow 0.1 SOL + fee buffer > treasury 1 SOL.
    expect(db.status.paused).toBe(true);
    expect(db.status.reason).toMatch(new RegExp(`^${SOLVENCY_PAUSE_REASON_PREFIX}`));
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0]?.chatId).toBe(777);
  });

  it('counts escrowed open-market stakes toward the required coverage', async () => {
    const { deps, db, chain } = makeFakeDeps();
    db.seedBalance(1, 0n); // no ledger balance...
    db.openSolMarkets = ['m1'];
    // ...but 5 SOL is escrowed in an open market and owed back on settlement.
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 5_000_000_000 });
    chain.treasuryLamports = 1_000_000_000n; // only 1 SOL on hand
    await createSolvencyMonitor(deps).tick();
    expect(db.status.paused).toBe(true);
  });

  it('recovery: clears its own pause once the treasury covers the book again', async () => {
    const { deps, db, chain, poster } = makeFakeDeps({ opsChatId: 777 });
    db.status = { paused: true, reason: `${SOLVENCY_PAUSE_REASON_PREFIX} shortfall` };
    db.seedBalance(1, 1_000_000_000n);
    chain.treasuryLamports = 10_000_000_000n;

    await createSolvencyMonitor(deps).tick();

    expect(db.status.paused).toBe(false);
    expect(poster.posts).toHaveLength(1); // recovery note to ops
  });

  it('never clears a manual ops pause', async () => {
    const { deps, db, chain } = makeFakeDeps();
    db.status = { paused: true, reason: 'ops: manual halt' };
    chain.treasuryLamports = 10_000_000_000n;
    await createSolvencyMonitor(deps).tick();
    expect(db.status.paused).toBe(true);
    expect(db.status.reason).toBe('ops: manual halt');
  });

  it('an RPC blip moves nothing', async () => {
    const { deps, db, chain, poster } = makeFakeDeps({ opsChatId: 777 });
    db.seedBalance(1, 100_000_000_000n); // wildly insolvent on paper
    chain.treasuryBalanceFails = true;
    await createSolvencyMonitor(deps).tick();
    expect(db.status.paused).toBe(false);
    expect(poster.posts).toHaveLength(0);
  });
});
