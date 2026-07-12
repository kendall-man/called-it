import { describe, expect, it } from 'vitest';
import { WAGER_TUNABLES } from './constants.js';
import { WAGER_COPY } from './copy.js';
import { makeFakeDeps } from './fakes.js';
import type {
  WagerMarketRow,
  WagerModuleDeps,
  WagerStarterStakeInput,
  WagerStakeTapArgs,
} from './port.js';
import { handleStakeTap } from './stake.js';
import { starterOnlyWagerDbFromFake } from './starter-fake.test-support.js';

const USER = 5;
const WALLET = 'WalletPubkey11111111111111111111111111111111';
const [PRESET_SMALL, PRESET_MID] = WAGER_TUNABLES.PRESET_STAKES_LAMPORTS;
type FundedStarterGrantCapability = Extract<keyof WagerModuleDeps, 'starterGrantsEnabled'>;

function market(): WagerMarketRow {
  return {
    id: 'm1',
    group_id: -300,
    status: 'open',
    quote_probability: 0.4,
    quote_multiplier: 2.2,
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

describe('starter stake contract', () => {
  it('keeps starter-grant capability out of funded module dependencies', () => {
    const capabilityIsAbsent: [FundedStarterGrantCapability] extends [never]
      ? true
      : false = true;

    expect(capabilityIsAbsent).toBe(true);
  });

  it('rejects a linked-wallet request before wallet lookup or balance fallback', async () => {
    // Given a linked funded user inside the strict starter-only runtime
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, WALLET);
    db.seedBalance(USER, 1_000_000_000n);
    let walletLookups = 0;
    const getWalletLink = db.getWalletLink.bind(db);
    db.getWalletLink = async (userId) => {
      walletLookups += 1;
      return getWalletLink(userId);
    };
    const starterDeps = {
      db: starterOnlyWagerDbFromFake(db),
      log: deps.log,
      runtimeMode: 'starter_only',
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    } as const;

    // When an ordinary balance-backed card request reaches the service
    const result = await handleStakeTap(starterDeps, tap({
      lamports: PRESET_MID,
      source: { kind: 'telegram_card', callbackId: 'funded-fallback' },
    }));

    // Then the application refuses it without consulting wallet or stake state
    expect(result).toEqual({ reply: WAGER_COPY.starterUnavailable(), placed: false });
    expect(walletLookups).toBe(0);
    expect(db.lastStakeArgs).toBeNull();
    expect(await db.balanceLamports(USER)).toBe(1_000_000_000n);
  });

  it('sends the fixed Telegram callback as an authoritative strict DB request', async () => {
    // Given an eligible fixed starter callback with no linked wallet
    const { deps, db } = makeFakeDeps();
    db.stakeResult = { ok: true, position_id: 'starter-position' };
    const starterDb = starterOnlyWagerDbFromFake(db);
    const wagerStarterStake = starterDb.wagerStarterStake;
    let starterInput: WagerStarterStakeInput | null = null;
    starterDb.wagerStarterStake = async (args) => {
      starterInput = args;
      return wagerStarterStake(args);
    };
    const starterDeps = {
      db: starterDb,
      log: deps.log,
      runtimeMode: 'starter_only',
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    } as const;

    // When the starter placement is attempted
    const result = await handleStakeTap(starterDeps, tap({
      source: { kind: 'telegram_default_card', callbackId: 'starter-fixed' },
    }));

    // Then the starter-specific method receives no funded selector
    expect(result.placed).toBe(true);
    expect(starterInput).not.toHaveProperty('starterOnly');
    expect(db.lastStakeArgs?.starterOnly).toBe(true);
  });

  it('does not treat a starter-shaped callback as a funded fallback', async () => {
    const { deps, db } = makeFakeDeps({
      walletMiniappEnabled: true,
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
  ] as const)('requires %s before a starter stake can begin', async (disabledFlag) => {
    const { deps, db } = makeFakeDeps({
      walletMiniappEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const starterDeps = {
      runtimeMode: 'starter_only',
      db: starterOnlyWagerDbFromFake(db),
      log: deps.log,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
      [disabledFlag]: false,
    } as const;

    const result = await handleStakeTap(starterDeps, tap({
      source: { kind: 'telegram_default_card', callbackId: `disabled-${disabledFlag}` },
    }));

    expect(result).toEqual({ reply: WAGER_COPY.starterUnavailable(), placed: false });
    expect(db.lastStakeArgs).toBeNull();
  });
});
