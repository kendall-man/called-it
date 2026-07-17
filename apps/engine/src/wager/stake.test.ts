import { describe, expect, it } from 'vitest';
import { doubtMultiplier } from '../pipeline/claims.js';
import { handleStakeTap, multiplierLabel, wagerDoubtMultiplier } from './stake.js';
import { WAGER_TUNABLES } from './constants.js';
import { WAGER_COPY } from './copy.js';
import { makeFakeDeps } from './fakes.js';
import type { WagerMarketRow, WagerStakeErrorCode, WagerStakeTapArgs } from './port.js';

const USER = 5;
const WALLET = 'WalletPubkey11111111111111111111111111111111';
const [PRESET_SMALL, PRESET_MID] = WAGER_TUNABLES.PRESET_STAKES_LAMPORTS;

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
    lamports: overrides.lamports ?? PRESET_SMALL,
    inPlay: overrides.inPlay ?? false,
    nowMs: overrides.nowMs ?? 1_000,
    ...(overrides.idempotencyKey !== undefined ? { idempotencyKey: overrides.idempotencyKey } : {}),
  };
}

describe('multiplier lock', () => {
  it('wagerDoubtMultiplier matches pipeline/claims doubtMultiplier exactly', () => {
    for (let percent = 1; percent <= 99; percent += 1) {
      const probability = percent / 100;
      expect(wagerDoubtMultiplier(probability)).toBe(doubtMultiplier(probability));
    }
    expect(wagerDoubtMultiplier(1)).toBe(doubtMultiplier(1));
    expect(wagerDoubtMultiplier(0)).toBe(doubtMultiplier(0));
  });
});

describe('handleStakeTap gates', () => {
  it('non-positive lamports → stale copy, no RPC call', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    const result = await handleStakeTap(deps, tap({ lamports: 0n }));
    expect(result.placed).toBe(false);
    expect(result.reply).toBe(WAGER_COPY.staleTap());
    expect(db.lastStakeArgs).toBeNull();
  });

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
});

describe('handleStakeTap placement', () => {
  it('escrows the exact lamports, locks the back multiplier', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);

    const result = await handleStakeTap(deps, tap({ lamports: PRESET_MID, side: 'back' }));

    expect(result.placed).toBe(true);
    expect(db.lastStakeArgs?.lamports).toBe(PRESET_MID);
    expect(db.lastStakeArgs?.multiplier).toBe(2.2); // quote_multiplier as-is
    expect(db.lastStakeArgs?.state).toBe('active'); // pre-kickoff
    expect(db.lastStakeArgs?.placed_at_ms).toBe(1_000);
    expect(result.reply).toContain('0.05 SOL');
    expect(result.reply).toContain('Nia');
  });

  it('locks the doubt multiplier from the quoted probability', async () => {
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

  it('forwards the client idempotency key on the first stake', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);

    const first = await handleStakeTap(deps, tap({ idempotencyKey: 'call-abc' }));
    expect(first.placed).toBe(true);
    expect(db.lastStakeArgs?.idempotency_key).toBe('call-abc');
  });

  it('a second tap on the same market nudges instead of stacking a position', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);

    const first = await handleStakeTap(deps, tap({ side: 'back' }));
    expect(first.placed).toBe(true);
    const positionsAfterFirst = db.positions.length;

    const repeat = await handleStakeTap(deps, tap({ side: 'back' }));
    expect(repeat.placed).toBe(false);
    expect(repeat.reply).toBe(WAGER_COPY.alreadyIn('back', PRESET_SMALL));
    expect(db.positions.length).toBe(positionsAfterFirst); // still one position
    expect(await db.balanceLamports(USER)).toBe(1_000_000_000n - PRESET_SMALL); // charged once
  });

  it('the nudge totals every held stake and reads the held side, not the tapped one', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedPosition({ market_id: 'm1', user_id: USER, side: 'doubt', stake: 10_000_000 });
    db.seedPosition({ market_id: 'm1', user_id: USER, side: 'doubt', stake: 40_000_000 });

    const repeat = await handleStakeTap(deps, tap({ side: 'doubt' }));
    expect(repeat.reply).toBe(WAGER_COPY.alreadyIn('doubt', 50_000_000n));
    expect(db.lastStakeArgs).toBeNull(); // never reached the RPC
  });

  it('tapping the opposite side of a held position gets pick-a-lane, no RPC', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedPosition({ market_id: 'm1', user_id: USER, side: 'back', stake: 10_000_000 });

    const flip = await handleStakeTap(deps, tap({ side: 'doubt' }));
    expect(flip.placed).toBe(false);
    expect(flip.reply).toBe(WAGER_COPY.pickALane());
    expect(db.lastStakeArgs).toBeNull();
  });

  it('a voided position does not block a fresh stake', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);
    db.seedPosition({ market_id: 'm1', user_id: USER, side: 'back', state: 'void' });

    const result = await handleStakeTap(deps, tap({ side: 'back' }));
    expect(result.placed).toBe(true);
  });

  it('RPC client-key dedup still backstops a race the position read missed', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);

    await handleStakeTap(deps, tap({ idempotencyKey: 'call-abc' }));
    // Simulate the read-then-stake race: the position is not visible to the
    // pre-check yet, so the tap falls through to the RPC's key dedup.
    db.positions.length = 0;
    const replay = await handleStakeTap(deps, tap({ idempotencyKey: 'call-abc' }));
    expect(replay.placed).toBe(false);
    expect(replay.reply).toBe(WAGER_COPY.stakeReplayed());
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
  it('one decimal under 10, integers above', () => {
    expect(multiplierLabel(2.25)).toBe('2.3');
    expect(multiplierLabel(2)).toBe('2');
    expect(multiplierLabel(14.6)).toBe('15');
  });
});
