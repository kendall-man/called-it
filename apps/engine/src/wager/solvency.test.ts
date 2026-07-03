import { describe, expect, it } from 'vitest';
import { createSolvencyMonitor, worstCaseLiabilityLamports } from './solvency.js';
import { SOLVENCY_PAUSE_REASON_PREFIX, WAGER_TUNABLES } from './constants.js';
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

describe('worstCaseLiabilityLamports', () => {
  it('is zero with no positions', () => {
    expect(worstCaseLiabilityLamports([])).toBe(0n);
  });

  it('takes the worse side payout minus ALL stakes', () => {
    const worst = worstCaseLiabilityLamports([
      position({ id: 'a', side: 'back', stake: 100, locked_multiplier: 2 }), // pays 200
      position({ id: 'b', side: 'doubt', stake: 50, locked_multiplier: 3 }), // pays 150
    ]);
    // max(200, 150) − (100 + 50) = 50
    expect(worst).toBe(50n);
  });

  it('the doubt side can be the worst case', () => {
    const worst = worstCaseLiabilityLamports([
      position({ id: 'a', side: 'back', stake: 100, locked_multiplier: 1.5 }), // pays 150
      position({ id: 'b', side: 'doubt', stake: 100, locked_multiplier: 5 }), // pays 500
    ]);
    expect(worst).toBe(500n - 200n);
  });

  it('floors at zero when stakes cover every outcome', () => {
    const worst = worstCaseLiabilityLamports([
      position({ id: 'a', side: 'back', stake: 100, locked_multiplier: 1.02 }), // pays 102
      position({ id: 'b', side: 'doubt', stake: 100, locked_multiplier: 1.5 }), // pays 150
    ]);
    // max(102, 150) − 200 < 0 → 0
    expect(worst).toBe(0n);
  });

  it('counts pending positions (they may activate) and ignores void ones', () => {
    const withPending = worstCaseLiabilityLamports([
      position({ id: 'a', side: 'back', stake: 100, locked_multiplier: 3, state: 'pending' }),
    ]);
    expect(withPending).toBe(200n);
    const withVoid = worstCaseLiabilityLamports([
      position({ id: 'a', side: 'back', stake: 100, locked_multiplier: 3, state: 'void' }),
    ]);
    expect(withVoid).toBe(0n);
  });

  it('uses the same milli-quantized payout as settlement', () => {
    const worst = worstCaseLiabilityLamports([
      position({ id: 'a', side: 'back', stake: 33_333_333, locked_multiplier: 1.333 }),
    ]);
    expect(worst).toBe(44_433_332n - 33_333_333n);
  });
});

describe('solvency monitor', () => {
  it('healthy book: leaves the breaker alone and asks for nothing', async () => {
    const { deps, db, chain, poster } = makeFakeDeps({ opsChatId: 777 });
    db.seedBalance(1, 1_000_000_000n);
    chain.treasuryLamports = 10_000_000_000n;
    await createSolvencyMonitor(deps).tick();
    expect(db.status.paused).toBe(false);
    expect(chain.airdrops).toHaveLength(0);
    expect(poster.posts).toHaveLength(0);
  });

  it('violation: persists the pause, requests an airdrop, alerts ops', async () => {
    const { deps, db, chain, poster } = makeFakeDeps({ opsChatId: 777 });
    db.seedBalance(1, 2_000_000_000n); // treasury owes 2 SOL
    chain.treasuryLamports = 1_000_000_000n; // holds 1 SOL
    db.openSolMarkets = ['m1'];
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 100_000_000, locked_multiplier: 3 });

    await createSolvencyMonitor(deps).tick();

    expect(db.status.paused).toBe(true);
    expect(db.status.reason).toMatch(new RegExp(`^${SOLVENCY_PAUSE_REASON_PREFIX}`));
    expect(chain.airdrops).toHaveLength(1);
    expect(chain.airdrops[0]).toBeLessThanOrEqual(WAGER_TUNABLES.MAX_AIRDROP_REQUEST_LAMPORTS);
    expect(chain.airdrops[0]).toBeGreaterThan(0n);
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0]?.chatId).toBe(777);
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

  it('airdrop failure still pauses and still alerts ops', async () => {
    const { deps, db, chain, poster } = makeFakeDeps({ opsChatId: 777 });
    db.seedBalance(1, 2_000_000_000n);
    chain.treasuryLamports = 0n;
    chain.airdropFails = true;
    await createSolvencyMonitor(deps).tick();
    expect(db.status.paused).toBe(true);
    expect(poster.posts).toHaveLength(1);
  });
});
