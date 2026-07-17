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
    source: overrides.source ?? { kind: 'durable_source', idempotencyKey: 'stake-test' },
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

  it('limits the starter source to the exact 0.01 SOL amount', async () => {
    const { deps, db } = makeFakeDeps({
      starterGrantsEnabled: true,
      walletMiniappEnabled: false,
      stakeAcceptanceEnabled: true,
    });
    const result = await handleStakeTap(deps, tap({
      lamports: PRESET_MID,
      source: { kind: 'telegram_default_card', callbackId: 'wrong-amount' },
    }));

    expect(result).toEqual({ reply: WAGER_COPY.unlinkedOnboarding(), placed: false });
    expect(db.lastStakeArgs).toBeNull();
  });

  it.each([
    'starterGrantsEnabled',
    'stakeAcceptanceEnabled',
  ] as const)('requires %s inside the wager module before a starter stake can begin', async (disabledFlag) => {
    const { deps, db } = makeFakeDeps({
      starterGrantsEnabled: true,
      walletMiniappEnabled: false,
      stakeAcceptanceEnabled: true,
      [disabledFlag]: false,
    });

    const result = await handleStakeTap(deps, tap({
      source: { kind: 'telegram_default_card', callbackId: `disabled-${disabledFlag}` },
    }));

    expect(result).toEqual({ reply: WAGER_COPY.unlinkedOnboarding(), placed: false });
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

  it('persists a coverage pause before a stake can create an uncovered position', async () => {
    const { deps, db, chain } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, PRESET_SMALL);
    chain.treasuryLamports = WAGER_TUNABLES.FEE_BUFFER_LAMPORTS + PRESET_SMALL - 1n;

    const result = await handleStakeTap(deps, tap());

    expect(result).toEqual({ reply: WAGER_COPY.paused(), placed: false });
    expect(db.status.paused).toBe(true);
    expect(db.lastStakeArgs).toBeNull();
    expect(db.positions).toHaveLength(0);
  });

  it('fails closed and persists a pause when the treasury balance cannot be read', async () => {
    const { deps, db, chain } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    chain.treasuryBalanceFails = true;

    const result = await handleStakeTap(deps, tap());

    expect(result).toEqual({ reply: WAGER_COPY.coverageUnavailable(), placed: false });
    expect(db.status.reason).toBe('solvency: treasury_unavailable');
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

  it('forwards the durable source key and reports a replay without re-staking', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);

    const first = await handleStakeTap(deps, tap({
      source: { kind: 'durable_source', idempotencyKey: 'call-abc' },
    }));
    expect(first.placed).toBe(true);
    expect(db.lastStakeArgs?.idempotency_key).toBe('call-abc');

    const positionsAfterFirst = db.positions.length;
    const replay = await handleStakeTap(deps, tap({
      source: { kind: 'durable_source', idempotencyKey: 'call-abc' },
    }));
    expect(replay.placed).toBe(false);
    expect(replay.reply).toBe(first.reply);
    expect(db.positions.length).toBe(positionsAfterFirst); // no second position
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
    ['closed', WAGER_COPY.marketClosed()],
    ['starter_unavailable', WAGER_COPY.starterUnavailable()],
    ['budget_exhausted', WAGER_COPY.budgetExhausted()],
    ['wallet_required', WAGER_COPY.walletRequired()],
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

  it('every refusal says that no SOL moved and gives one recovery action', () => {
    for (const [, line] of cases) {
      expect(line).toMatch(/no SOL moved|unchanged/i);
      expect(line).toMatch(/try another allowlisted beta group|pick a lane|choose another call|check \/me|use \/deposit|open \/wallet/i);
    }
  });
});

describe('multiplierLabel', () => {
  it('one decimal under 10, integers above', () => {
    expect(multiplierLabel(2.25)).toBe('2.3');
    expect(multiplierLabel(2)).toBe('2');
    expect(multiplierLabel(14.6)).toBe('15');
  });
});
