/**
 * STAGING SEAM tests: flag-gated play-money onboarding ("no real devnet").
 * Off (0n) must leave production behavior byte-identical; on must let a
 * brand-new user stake with zero manual setup, granting exactly once.
 */

import { describe, expect, it } from 'vitest';
import { handleStakeTap } from './stake.js';
import { WAGER_COPY } from './copy.js';
import { WAGER_TUNABLES } from './constants.js';
import { makeFakeDeps } from './fakes.js';
import type { WagerLogger, WagerMarketRow, WagerStakeTapArgs } from './port.js';

const USER = 5;
const GRANT = 200_000_000n; // 0.2 SOL of play money
const [PRESET_SMALL] = WAGER_TUNABLES.PRESET_STAKES_LAMPORTS;

function market(): WagerMarketRow {
  return { id: 'm1', group_id: -300, status: 'open', quote_probability: 0.4, quote_multiplier: 2.2 };
}

function tap(overrides: Partial<WagerStakeTapArgs> = {}): WagerStakeTapArgs {
  return {
    market: market(),
    userId: USER,
    userName: 'Nia',
    side: 'back',
    lamports: PRESET_SMALL,
    inPlay: false,
    nowMs: 1_000,
    ...overrides,
  };
}

function collectingLog(): { log: WagerLogger; events: string[] } {
  const events: string[] = [];
  const push = (event: string) => {
    events.push(event);
  };
  return { log: { info: push, warn: push, error: push }, events };
}

describe('staging grant seam', () => {
  it('flag off (default): unlinked user is rejected exactly like production', async () => {
    const { deps, db } = makeFakeDeps();
    const result = await handleStakeTap(deps, tap());
    expect(result.placed).toBe(false);
    expect(result.reply).toBe(WAGER_COPY.unlinkedOnboarding());
    expect(await db.getWalletLink(USER)).toBeNull();
    expect(await db.balanceLamports(USER)).toBe(0n);
  });

  it('flag on: a brand-new user stakes with zero manual setup', async () => {
    const { log } = collectingLog();
    const { deps, db } = makeFakeDeps({ stagingGrantLamports: GRANT, log });

    const result = await handleStakeTap(deps, tap());

    expect(result.placed).toBe(true);
    expect((await db.getWalletLink(USER))?.pubkey).toBe(`staging-play-${USER}`);
    expect(db.lastStakeArgs?.lamports).toBe(PRESET_SMALL);
  });

  it('flag on: the grant posts exactly once across repeated stakes', async () => {
    const { log, events } = collectingLog();
    const { deps } = makeFakeDeps({ stagingGrantLamports: GRANT, log });

    await handleStakeTap(deps, tap());
    await handleStakeTap(deps, tap({ side: 'back', nowMs: 2_000 }));

    expect(events.filter((event) => event === 'staging_grant_posted')).toHaveLength(1);
  });

  it('flag on: a user with a real linked wallet keeps their pubkey', async () => {
    const REAL_WALLET = 'WalletPubkey11111111111111111111111111111111';
    const { deps, db } = makeFakeDeps({ stagingGrantLamports: GRANT });
    db.seedLink(USER, REAL_WALLET);

    await handleStakeTap(deps, tap());

    expect((await db.getWalletLink(USER))?.pubkey).toBe(REAL_WALLET);
  });
});
