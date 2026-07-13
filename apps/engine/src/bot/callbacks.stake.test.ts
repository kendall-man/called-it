/**
 * Callback-level coverage for the beta's single, fixed 0.01 test-SOL position.
 */

import { describe, expect, it } from 'vitest';
import { dispatchCallback } from './callbacks.js';
import { renderFallback } from './copy.js';
import {
  CHAT_ID,
  INPLAY_CUTOFF,
  MARKET_ID,
  PRESET_01,
  USER_A,
  fixtureAt,
  makeStakeContext as stakeCtx,
  makeStakeHarness as makeHarness,
  stakeAction as stake,
  stakeMarket as market,
} from './callbacks.stake.test-support.js';

describe('handleStake - beta starter position', () => {
  it('places the exact default Telegram tap with one atomic starter grant', async () => {
    const harness = makeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const { ctx, toasts } = stakeCtx(USER_A, 'starter-first-tap');

    await dispatchCallback(harness.h, ctx, stake('back', PRESET_01));

    expect(harness.wagerDb.lastStakeArgs).toMatchObject({
      idempotency_key: 'telegram:callback:starter-first-tap',
      starterOnly: true,
      lamports: 10_000_000n,
    });
    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(harness.wagerDb.ledger).toMatchObject([
      { kind: 'starter_grant', lamports: 10_000_000n },
      { kind: 'stake', lamports: -10_000_000n },
    ]);
    expect(toasts).toHaveLength(1);
  });

  it('replays one callback id without another grant, position, or card refresh', async () => {
    const harness = makeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
    });
    const { ctx, toasts } = stakeCtx(USER_A, 'starter-replay');

    await Promise.all(
      Array.from({ length: 10 }, () => dispatchCallback(harness.h, ctx, stake('back', PRESET_01))),
    );

    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(harness.wagerDb.ledger.filter((entry) => entry.kind === 'starter_grant')).toHaveLength(1);
    expect(harness.wagerDb.ledger.filter((entry) => entry.kind === 'stake')).toHaveLength(1);
    expect(new Set(toasts).size).toBe(1);
    expect(harness.cardEdits).toEqual([{ chatId: CHAT_ID, marketId: MARKET_ID, messageId: 900 }]);
  });

  it('does not issue another starter position for a later callback', async () => {
    const harness = makeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const first = stakeCtx(USER_A, 'starter-first');
    const second = stakeCtx(USER_A, 'starter-second');

    await dispatchCallback(harness.h, first.ctx, stake('back', PRESET_01));
    await dispatchCallback(harness.h, second.ctx, stake('back', PRESET_01));

    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(harness.wagerDb.ledger.filter((entry) => entry.kind === 'starter_grant')).toHaveLength(1);
    expect(second.toasts).toEqual([expect.stringMatching(/no SOL moved/i)]);
    expect(second.toasts.join(' ')).not.toContain('/wallet');
  });

  it.each([{ starterGrantsEnabled: false }, { stakeAcceptanceEnabled: false }])(
    'does not create an unlinked starter position while a rollout switch is off',
    async (switches) => {
      const harness = makeHarness({
        link: false,
        balanceLamports: null,
        starterGrantsEnabled: true,
        stakeAcceptanceEnabled: true,
        ...switches,
      });
      const { ctx, toasts } = stakeCtx(USER_A, `starter-switch-${JSON.stringify(switches)}`);

      await dispatchCallback(harness.h, ctx, stake('back', PRESET_01));

      expect(harness.wagerDb.positions).toHaveLength(0);
      expect(harness.wagerDb.ledger).toHaveLength(0);
      expect(toasts).toEqual([
        expect.stringMatching(
          /starter 0\.01 SOL position using test SOL.*no monetary value.*No SOL moved/i,
        ),
      ]);
    },
  );

  it('commits only one side when opposite first taps race', async () => {
    const harness = makeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const back = stakeCtx(USER_A, 'starter-race-back');
    const doubt = stakeCtx(USER_A, 'starter-race-doubt');

    await Promise.all([
      dispatchCallback(harness.h, back.ctx, stake('back', PRESET_01)),
      dispatchCallback(harness.h, doubt.ctx, stake('doubt', PRESET_01)),
    ]);

    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(harness.wagerDb.ledger.filter((entry) => entry.kind === 'starter_grant')).toHaveLength(1);
    expect(harness.wagerDb.ledger.filter((entry) => entry.kind === 'stake')).toHaveLength(1);
  });

  it('treats a non-SOL market as a stale tap', async () => {
    const harness = makeHarness({ marketRow: market({ currency: 'rep' }) });
    const { ctx, toasts } = stakeCtx(USER_A);

    await dispatchCallback(harness.h, ctx, stake('back', PRESET_01));

    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(toasts).toContain(renderFallback('stale'));
  });

  it('refuses a starter position after the in-play cutoff', async () => {
    const harness = makeHarness({ fixture: fixtureAt('H2', INPLAY_CUTOFF) });
    const { ctx, toasts } = stakeCtx(USER_A);

    await dispatchCallback(harness.h, ctx, stake('back', PRESET_01));

    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(toasts).toContain(renderFallback('window_closed'));
  });

  it('uses virtual replay time instead of the durable final fixture for the stake cutoff', async () => {
    const harness = makeHarness({
      marketRow: market({ is_replay: true }),
      fixture: fixtureAt('F', 90),
      replayFixture: fixtureAt('H1', 10),
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const first = stakeCtx(USER_A, 'replay-before-cutoff');
    const duplicate = stakeCtx(USER_A, 'replay-before-cutoff-again');

    await dispatchCallback(harness.h, first.ctx, stake('back', PRESET_01));
    await dispatchCallback(harness.h, duplicate.ctx, stake('back', PRESET_01));

    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(harness.wagerDb.ledger).toHaveLength(0);
    expect(first.toasts).toEqual([renderFallback('replay_position_recorded')]);
    expect(duplicate.toasts).toEqual([renderFallback('replay_position_exists')]);
  });

  it('reports a closed market without creating a position', async () => {
    const harness = makeHarness({ marketRow: market({ status: 'settled' }) });
    const { ctx, toasts } = stakeCtx(USER_A);

    await dispatchCallback(harness.h, ctx, stake('back', PRESET_01));

    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(toasts.some((toast) => toast.toLowerCase().includes('settled'))).toBe(true);
  });
});
