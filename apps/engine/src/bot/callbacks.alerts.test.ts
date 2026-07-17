/**
 * Money-path callback failures must be modal alerts (show_alert), while
 * success acks stay ephemeral toasts. Copy is asserted elsewhere; these tests
 * pin WHICH channel each answer takes.
 */

import { describe, expect, it } from 'vitest';
import { dispatchCallback } from './callbacks.js';
import { renderFallback } from './copy.js';
import {
  escrowPlacementRejectionText,
  type EscrowTelegramPort,
} from './escrow-ux.js';
import {
  INPLAY_CUTOFF,
  PRESET_01,
  USER_A,
  fixtureAt,
  makeStakeContext,
  makeStakeHarness,
  stakeAction,
  stakeMarket,
} from './callbacks.stake.test-support.js';

const TOKEN = 'a'.repeat(43);

function rejectingEscrowPort(code: 'wallet_required' | 'paused'): EscrowTelegramPort {
  return {
    async createPlacementSession() {
      return { kind: 'rejected', code };
    },
    async createWalletSession() {
      return { kind: 'rejected', code: 'temporarily_unavailable' };
    },
  };
}

function creatingEscrowPort(): EscrowTelegramPort {
  return {
    async createPlacementSession() {
      return {
        kind: 'created',
        token: TOKEN,
        expiresAt: '2026-07-06T18:05:00.000Z',
        duplicate: false,
      };
    },
    async createWalletSession() {
      return { kind: 'rejected', code: 'temporarily_unavailable' };
    },
  };
}

describe('money-path callback alert routing', () => {
  it('answers an escrow wallet_required rejection as a modal alert', async () => {
    const harness = makeStakeHarness({
      custodyMode: 'escrow',
      escrow: rejectingEscrowPort('wallet_required'),
    });
    const tap = makeStakeContext(USER_A, 'escrow-wallet-required');

    await dispatchCallback(harness.h, tap.ctx, stakeAction('back', PRESET_01));

    expect(tap.alerts).toEqual([escrowPlacementRejectionText('wallet_required')]);
  });

  it('answers a paused escrow desk as a modal alert', async () => {
    const harness = makeStakeHarness({
      custodyMode: 'escrow',
      escrow: rejectingEscrowPort('paused'),
    });
    const tap = makeStakeContext(USER_A, 'escrow-paused');

    await dispatchCallback(harness.h, tap.ctx, stakeAction('back', PRESET_01));

    expect(tap.alerts).toEqual([escrowPlacementRejectionText('paused')]);
  });

  it('keeps the escrow signing-link success ack as a plain toast', async () => {
    const harness = makeStakeHarness({
      custodyMode: 'escrow',
      escrow: creatingEscrowPort(),
    });
    const tap = makeStakeContext(USER_A, 'escrow-success');

    await dispatchCallback(harness.h, tap.ctx, stakeAction('back', PRESET_01));

    expect(tap.privateMessages).toHaveLength(1);
    expect(tap.toasts).toHaveLength(1);
    expect(tap.alerts).toEqual([]);
  });

  it('alerts when the private signing DM cannot be delivered', async () => {
    const harness = makeStakeHarness({
      custodyMode: 'escrow',
      escrow: creatingEscrowPort(),
    });
    const tap = makeStakeContext(USER_A, 'escrow-dm-blocked');
    (tap.ctx as unknown as {
      api: { sendMessage: () => Promise<never> };
    }).api.sendMessage = async () => {
      throw new Error('Forbidden: bot was blocked by the user');
    };

    await dispatchCallback(harness.h, tap.ctx, stakeAction('back', PRESET_01));

    expect(tap.alerts).toEqual([
      'Open my private chat, run /wallet, then tap your choice again. No assets moved.',
    ]);
  });

  it('alerts on a closed market instead of toasting', async () => {
    const harness = makeStakeHarness({ marketRow: stakeMarket({ status: 'settled' }) });
    const tap = makeStakeContext(USER_A, 'closed-market');

    await dispatchCallback(harness.h, tap.ctx, stakeAction('back', PRESET_01));

    expect(tap.alerts).toEqual(['Settled.']);
  });

  it('alerts on the in-play cutoff rejection', async () => {
    const harness = makeStakeHarness({ fixture: fixtureAt('H2', INPLAY_CUTOFF) });
    const tap = makeStakeContext(USER_A, 'cutoff');

    await dispatchCallback(harness.h, tap.ctx, stakeAction('back', PRESET_01));

    expect(tap.alerts).toEqual([renderFallback('window_closed')]);
  });

  it('alerts a legacy stake rejection but keeps a placed stake as a toast', async () => {
    const rejected = makeStakeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: false,
    });
    const rejectedTap = makeStakeContext(USER_A, 'legacy-paused');
    await dispatchCallback(rejected.h, rejectedTap.ctx, stakeAction('back', PRESET_01));

    expect(rejectedTap.alerts).toEqual([expect.stringMatching(/temporarily paused/i)]);

    const placed = makeStakeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const placedTap = makeStakeContext(USER_A, 'legacy-placed');
    await dispatchCallback(placed.h, placedTap.ctx, stakeAction('back', PRESET_01));

    expect(placed.wagerDb.positions).toHaveLength(1);
    expect(placedTap.toasts).toHaveLength(1);
    expect(placedTap.alerts).toEqual([]);
  });

  it('keeps the idempotent same-callback replay of a placed stake as a toast', async () => {
    const harness = makeStakeHarness({
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const tap = makeStakeContext(USER_A, 'legacy-idempotent-replay');

    await dispatchCallback(harness.h, tap.ctx, stakeAction('back', PRESET_01));
    await dispatchCallback(harness.h, tap.ctx, stakeAction('back', PRESET_01));

    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(tap.alerts).toEqual([]);
    expect(tap.toasts).toHaveLength(2);
  });

  it('alerts a duplicate replay position and a stale replay admission', async () => {
    const harness = makeStakeHarness({
      marketRow: stakeMarket({ is_replay: true }),
      fixture: fixtureAt('F', 90),
      replayFixture: fixtureAt('H1', 10),
      link: false,
      balanceLamports: null,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const first = makeStakeContext(USER_A, 'replay-first');
    const duplicate = makeStakeContext(USER_A, 'replay-duplicate');

    await dispatchCallback(harness.h, first.ctx, stakeAction('back', PRESET_01));
    await dispatchCallback(harness.h, duplicate.ctx, stakeAction('back', PRESET_01));

    expect(first.alerts).toEqual([]);
    expect(duplicate.alerts).toEqual([renderFallback('replay_position_exists')]);

    const stale = makeStakeHarness({
      marketRow: stakeMarket({ is_replay: true }),
      fixture: fixtureAt('F', 90),
      replayFixture: null,
    });
    const staleTap = makeStakeContext(USER_A, 'replay-stale');
    await dispatchCallback(stale.h, staleTap.ctx, stakeAction('back', PRESET_01));

    expect(staleTap.alerts).toEqual(['That test call is no longer active. No assets moved.']);
  });
});
