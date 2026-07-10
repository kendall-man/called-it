/**
 * Behavior tests for the SOL stake path (handleStake via dispatchCallback).
 * Every market is a SOL market now: handleStake resolves the preset index to
 * lamports and delegates to the wager module (which owns funds, gates, copy).
 * These pin the callback-level behavior — preset→lamports, non-sol/closed
 * guards, the in-play cutoff, and the card refresh on a placed bet.
 */

import { describe, expect, it } from 'vitest';
import { dispatchCallback } from './callbacks.js';
import { renderFallback } from './copy.js';
import {
  CHAT_ID,
  INPLAY_CUTOFF,
  MARKET_ID,
  PRESET_01,
  PRESET_05,
  PRESET_10,
  USER_A,
  fixtureAt,
  makeStakeContext as stakeCtx,
  makeStakeHarness as makeHarness,
  stakeAction as stake,
  stakeMarket as market,
} from './callbacks.stake.test-support.js';

describe('handleStake — SOL delegate', () => {
  it('places the exact default Telegram tap with one atomic starter grant', async () => {
    const hz = makeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      walletMiniappEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const { ctx, toasts } = stakeCtx(USER_A, 'starter-first-tap');

    await dispatchCallback(hz.h, ctx, stake('back', PRESET_01));

    expect(hz.wagerDb.lastStakeArgs).toMatchObject({
      idempotency_key: 'telegram:callback:starter-first-tap',
      allow_starter: true,
      lamports: 10_000_000n,
    });
    expect(hz.wagerDb.positions).toHaveLength(1);
    expect(hz.wagerDb.ledger).toMatchObject([
      { kind: 'starter_grant', lamports: 10_000_000n },
      { kind: 'stake', lamports: -10_000_000n },
    ]);
    expect(toasts).toHaveLength(1);
  });

  it('replays one callback id without a second grant, position, response, or card refresh', async () => {
    const hz = makeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      walletMiniappEnabled: true,
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
    });
    const { ctx, toasts } = stakeCtx(USER_A, 'starter-replay');

    await Promise.all(
      Array.from({ length: 10 }, () => dispatchCallback(hz.h, ctx, stake('back', PRESET_01))),
    );

    expect(hz.wagerDb.positions).toHaveLength(1);
    expect(hz.wagerDb.ledger.filter((entry) => entry.kind === 'starter_grant')).toHaveLength(1);
    expect(hz.wagerDb.ledger.filter((entry) => entry.kind === 'stake')).toHaveLength(1);
    expect(new Set(toasts).size).toBe(1);
    expect(hz.cardEdits).toEqual([{ chatId: CHAT_ID, marketId: MARKET_ID, messageId: 900 }]);
  });

  it('does not issue another starter grant for a distinct later callback', async () => {
    const hz = makeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      walletMiniappEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const first = stakeCtx(USER_A, 'starter-first');
    const second = stakeCtx(USER_A, 'starter-second');

    await dispatchCallback(hz.h, first.ctx, stake('back', PRESET_01));
    await dispatchCallback(hz.h, second.ctx, stake('back', PRESET_01));

    expect(hz.wagerDb.positions).toHaveLength(1);
    expect(hz.wagerDb.ledger.filter((entry) => entry.kind === 'starter_grant')).toHaveLength(1);
    expect(second.toasts).toEqual([expect.stringContaining('/wallet')]);
  });

  it.each([
    { starterGrantsEnabled: false },
    { walletMiniappEnabled: false },
    { stakeAcceptanceEnabled: false },
  ])('does not start an unlinked default tap while a rollout switch is off', async (switches) => {
    const hz = makeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      walletMiniappEnabled: true,
      stakeAcceptanceEnabled: true,
      ...switches,
    });
    const { ctx, toasts } = stakeCtx(USER_A, `starter-switch-${JSON.stringify(switches)}`);

    await dispatchCallback(hz.h, ctx, stake('back', PRESET_01));

    expect(hz.wagerDb.positions).toHaveLength(0);
    expect(hz.wagerDb.ledger).toHaveLength(0);
    expect(toasts).toEqual([expect.stringContaining('/wallet')]);
  });

  it('keeps a funded default tap on the ordinary debit path', async () => {
    const hz = makeHarness({
      starterGrantsEnabled: true,
      walletMiniappEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const { ctx } = stakeCtx(USER_A, 'funded-default');

    await dispatchCallback(hz.h, ctx, stake('back', PRESET_01));

    expect(hz.wagerDb.positions).toHaveLength(1);
    expect(hz.wagerDb.ledger.filter((entry) => entry.kind === 'starter_grant')).toHaveLength(0);
    expect(hz.wagerDb.ledger.filter((entry) => entry.kind === 'stake')).toHaveLength(1);
  });

  it('commits only one side when opposite first taps race', async () => {
    const hz = makeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      walletMiniappEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const back = stakeCtx(USER_A, 'starter-race-back');
    const doubt = stakeCtx(USER_A, 'starter-race-doubt');

    await Promise.all([
      dispatchCallback(hz.h, back.ctx, stake('back', PRESET_01)),
      dispatchCallback(hz.h, doubt.ctx, stake('doubt', PRESET_01)),
    ]);

    expect(hz.wagerDb.positions).toHaveLength(1);
    expect(hz.wagerDb.ledger.filter((entry) => entry.kind === 'starter_grant')).toHaveLength(1);
    expect(hz.wagerDb.ledger.filter((entry) => entry.kind === 'stake')).toHaveLength(1);
    expect([...back.toasts, ...doubt.toasts]).toHaveLength(2);
  });

  it('resolves the preset index to lamports and places one position', async () => {
    const hz = makeHarness();
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(1);
    // 0.05 SOL preset → 50_000_000 lamports (stored as a JS number on the row).
    expect(hz.wagerDb.positions[0]).toMatchObject({ side: 'back', stake: 50_000_000, user_id: USER_A });
    expect(toasts).toHaveLength(1);
  });

  it('maps each preset index to the right lamport amount', async () => {
    for (const [index, lamports] of [
      [PRESET_01, 10_000_000],
      [PRESET_05, 50_000_000],
      [PRESET_10, 100_000_000],
    ] as const) {
      const hz = makeHarness();
      const { ctx } = stakeCtx(USER_A);
      await dispatchCallback(hz.h, ctx, stake('back', index));
      expect(hz.wagerDb.positions[0]?.stake).toBe(lamports);
    }
  });

  it('treats a non-SOL market as a stale tap (no Rep path exists)', async () => {
    const hz = makeHarness({ marketRow: market({ currency: 'rep' }) });
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(0);
    expect(toasts).toContain(renderFallback('stale'));
  });

  it('refuses a stake once the match is past the in-play cutoff', async () => {
    const hz = makeHarness({ fixture: fixtureAt('H2', INPLAY_CUTOFF) });
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(0);
    expect(toasts).toContain(renderFallback('window_closed'));
  });

  it('reports a closed market with its status line', async () => {
    const hz = makeHarness({ marketRow: market({ status: 'settled' }) });
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(0);
    expect(toasts.some((t) => t.toLowerCase().includes('settled'))).toBe(true);
  });

  it('onboards an unlinked member instead of placing a bet', async () => {
    const hz = makeHarness({ link: false });
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(0);
    expect(toasts.some((t) => t.toLowerCase().includes('/wallet'))).toBe(true);
  });

  it('relays an insufficient-balance refusal from the wager desk', async () => {
    const hz = makeHarness({ balanceLamports: 1_000_000n }); // 0.001 SOL < 0.05 preset
    const { ctx, toasts } = stakeCtx(USER_A);
    await dispatchCallback(hz.h, ctx, stake('back', PRESET_05));
    expect(hz.wagerDb.positions).toHaveLength(0);
    expect(toasts.some((t) => t.toLowerCase().includes('sol'))).toBe(true);
  });
});
