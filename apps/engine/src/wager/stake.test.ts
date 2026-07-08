import { describe, expect, it } from 'vitest';
import { doubtMultiplier } from '../pipeline/claims.js';
import { handleStakeTap, multiplierLabel, wagerDoubtMultiplier } from './stake.js';
import { WAGER_TUNABLES } from './constants.js';
import { WAGER_COPY } from './copy.js';
import { makeFakeDeps } from './fakes.js';
import type { WagerMarketRow, WagerStakeErrorCode, WagerStakeTapArgs } from './port.js';

const USER = 5;
const WALLET = 'WalletPubkey11111111111111111111111111111111';

function market(overrides: Partial<WagerMarketRow> = {}): WagerMarketRow {
  return {
    id: overrides.id ?? 'm1',
    group_id: overrides.group_id ?? -300,
    status: overrides.status ?? 'open',
    quote_probability: overrides.quote_probability ?? 0.4,
    quote_multiplier: overrides.quote_multiplier ?? 2.2,
  };
}

function tap(overrides: Partial<WagerStakeTapArgs> = {}): WagerStakeTapArgs {
  return {
    market: overrides.market ?? market(),
    userId: overrides.userId ?? USER,
    userName: overrides.userName ?? 'Nia',
    side: overrides.side ?? 'back',
    presetIndex: overrides.presetIndex ?? 0,
    inPlay: overrides.inPlay ?? false,
    nowMs: overrides.nowMs ?? 1_000,
  };
}

describe('multiplier lock parity with the Rep path', () => {
  it('wagerDoubtMultiplier matches pipeline/claims doubtMultiplier exactly', () => {
    for (let percent = 1; percent <= 99; percent += 1) {
      const probability = percent / 100;
      expect(wagerDoubtMultiplier(probability)).toBe(doubtMultiplier(probability));
    }
    // clamp edges
    expect(wagerDoubtMultiplier(1)).toBe(doubtMultiplier(1));
    expect(wagerDoubtMultiplier(0)).toBe(doubtMultiplier(0));
  });
});

describe('handleStakeTap gates', () => {
  it('unlinked wallet → onboarding copy, no RPC call', async () => {
    const { deps, db } = makeFakeDeps();
    const result = await handleStakeTap(deps, tap());
    expect(result.placed).toBe(false);
    expect(result.reply).toBe(WAGER_COPY.unlinkedOnboarding());
    expect(db.lastStakeArgs).toBeNull();
  });

  it('paused breaker → paused copy, no RPC call', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.status = { paused: true, reason: 'solvency: shortfall' };
    const result = await handleStakeTap(deps, tap());
    expect(result.placed).toBe(false);
    expect(result.reply).toBe(WAGER_COPY.paused());
    expect(db.lastStakeArgs).toBeNull();
  });

  it('unknown preset index → stale copy', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);
    const result = await handleStakeTap(deps, tap({ presetIndex: 9 }));
    expect(result.placed).toBe(false);
    expect(result.reply).toBe(WAGER_COPY.staleTap());
  });
});

describe('handleStakeTap placement', () => {
  it('resolves the preset, locks the back multiplier, escrows via the RPC', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);

    const result = await handleStakeTap(deps, tap({ presetIndex: 1, side: 'back' }));

    expect(result.placed).toBe(true);
    expect(db.lastStakeArgs?.lamports).toBe(WAGER_TUNABLES.PRESET_STAKES_LAMPORTS[1]);
    expect(db.lastStakeArgs?.multiplier).toBe(2.2); // quote_multiplier as-is
    expect(db.lastStakeArgs?.state).toBe('active'); // pre-kickoff
    expect(db.lastStakeArgs?.placed_at_ms).toBe(1_000);
    expect(result.reply).toContain('0.05 SOL');
    expect(result.reply).toContain('Nia');
  });

  it('locks the doubt multiplier from the quoted probability, Rep-identically', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);

    await handleStakeTap(deps, tap({ side: 'doubt' }));

    expect(db.lastStakeArgs?.multiplier).toBe(doubtMultiplier(0.4));
  });

  it('in-play taps ride the pending window', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);
    await handleStakeTap(deps, tap({ inPlay: true }));
    expect(db.lastStakeArgs?.state).toBe('pending');
  });

  it('remembers the group for deposit/cashout notifications', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);
    await handleStakeTap(deps, tap({ market: market({ group_id: -300 }) }));
    expect(db.links.get(USER)?.last_wager_group_id).toBe(-300);
  });
});

describe('typed RPC errors map to distinct copy', () => {
  const cases: Array<[WagerStakeErrorCode, string]> = [
    ['insufficient', WAGER_COPY.insufficient(0n)],
    ['wrong_side', WAGER_COPY.pickALane()],
    ['cap', WAGER_COPY.capReached(WAGER_TUNABLES.PER_MARKET_STAKE_CAP_LAMPORTS)],
    ['liability_cap', WAGER_COPY.fullyLoaded()],
    ['paused', WAGER_COPY.paused()],
  ];

  it.each(cases)('%s', async (code, expected) => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.stakeResult = { ok: false, code };
    const result = await handleStakeTap(deps, tap());
    expect(result.placed).toBe(false);
    expect(result.reply).toBe(expected);
  });

  it('every error line is distinct — no two failures read the same', () => {
    const lines = cases.map(([, line]) => line);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe('multiplierLabel', () => {
  it('mirrors the Rep display rule (one decimal under 10, integers above)', () => {
    expect(multiplierLabel(2.25)).toBe('2.3');
    expect(multiplierLabel(2)).toBe('2');
    expect(multiplierLabel(14.6)).toBe('15');
  });
});
