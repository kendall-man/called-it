/**
 * Two-step stake ladder (STAKE_LADDER_ENABLED). Verifies the side tap moves no
 * SOL, the value tap commits (legacy) or hands off to signing (escrow), Back is
 * lossless, and — critically — that with the flag OFF the single-tap flow is
 * unchanged.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { InlineKeyboard } from 'grammy';
import { dispatchCallback } from './callbacks.js';
import { decodeCallback } from './callbackData.js';
import { configureMiniAppOfferKeyboards } from './keyboards.js';
import type { EscrowTelegramPort } from './escrow-ux.js';
import {
  MARKET_ID,
  PRESET_01,
  USER_A,
  makeStakeContext as stakeCtx,
  makeStakeHarness as makeHarness,
  stakeAction as stake,
  stakeBackAction as back,
  stakeValueAction as value,
} from './callbacks.stake.test-support.js';

function keyboardLabels(keyboard: InlineKeyboard | undefined): string[] {
  return (keyboard?.inline_keyboard ?? []).flat().map((button) => button.text);
}

function recordingEscrowPort(): { port: EscrowTelegramPort; readonly calls: number } {
  const state = { calls: 0 };
  const port: EscrowTelegramPort = {
    async createPlacementSession() {
      state.calls += 1;
      return { kind: 'created', token: 'x'.repeat(43), expiresAt: '2026-07-06T18:05:00.000Z', duplicate: false };
    },
    async createWalletSession() {
      return { kind: 'created', token: 'x'.repeat(43), expiresAt: '2026-07-06T18:05:00.000Z' };
    },
  };
  return {
    port,
    get calls() {
      return state.calls;
    },
  };
}

afterEach(() => configureMiniAppOfferKeyboards(null));

describe('two-step stake ladder — flag off parity', () => {
  it('with the flag OFF the side tap still places a position (single-tap flow)', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: false,
    });
    const { ctx } = stakeCtx(USER_A, 'off-1');
    await dispatchCallback(harness.h, ctx, stake('back', PRESET_01));
    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(harness.uiState).toBeNull();
  });
});

describe('two-step stake ladder — flag on', () => {
  it('the side tap moves ZERO SOL: opens the ladder and records the side only', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    const { ctx, toasts } = stakeCtx(USER_A, 'on-side');
    await dispatchCallback(harness.h, ctx, stake('back', PRESET_01));

    // No position and no stake/grant ledger movement — the side tap is free.
    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(harness.wagerDb.ledger.filter((entry) => entry.kind === 'stake' || entry.kind === 'starter_grant'))
      .toHaveLength(0);
    // The card evolved into the value ladder, urgently, on the same message.
    expect(harness.uiState?.get(MARKET_ID)).toEqual({ kind: 'ladder', side: 'back' });
    const edit = harness.cardSurfaces.at(-1);
    expect(edit?.messageId).toBe(900);
    expect(edit?.urgent).toBe(true);
    const labels = keyboardLabels(edit?.keyboard);
    expect(labels).toEqual(['0.01 SOL', '0.02 SOL', '0.05 SOL', '0.1 SOL', '← Back']);
    // The toast names the side, no amount.
    expect(toasts.at(-1)).toBe('Brazil win it — now pick a size below.');
  });

  it('the value tap commits the CHOSEN amount (legacy) and clears the ladder', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    // Open the ladder first (side tap), then pick 0.02 SOL (code 2).
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'v-side').ctx, stake('back', PRESET_01));
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'v-value').ctx, value('back', 2));

    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(harness.wagerDb.lastStakeArgs).toMatchObject({ lamports: 20_000_000n, side: 'back' });
    // The ladder is cleared; the card returned to the two-side offer.
    expect(harness.uiState?.get(MARKET_ID)).toBeNull();
    expect(keyboardLabels(harness.cardSurfaces.at(-1)?.keyboard)).toEqual(['Brazil win it', "They don't"]);
  });

  it('the base 0.01 rung still commits at exactly 0.01 SOL', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'base-side').ctx, stake('doubt', PRESET_01));
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'base-value').ctx, value('doubt', 1));
    expect(harness.wagerDb.lastStakeArgs).toMatchObject({ lamports: 10_000_000n, side: 'doubt' });
  });

  it('Back losslessly returns to the two-side offer and clears the ladder', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'b-side').ctx, stake('back', PRESET_01));
    const { ctx, toasts } = stakeCtx(USER_A, 'b-back');
    await dispatchCallback(harness.h, ctx, back());

    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(harness.uiState?.get(MARKET_ID)).toBeNull();
    expect(keyboardLabels(harness.cardSurfaces.at(-1)?.keyboard)).toEqual(['Brazil win it', "They don't"]);
    expect(toasts.at(-1)).toBe('Back to the call.');
  });

  it('escrow: the value tap hands off to in-card signing and mints NO session', async () => {
    configureMiniAppOfferKeyboards({
      custodyMode: 'escrow',
      miniAppShortName: 'app',
      botUsername: () => 'callit_testing_bot',
    });
    const escrow = recordingEscrowPort();
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      custodyMode: 'escrow',
      refreshableCard: true,
      ladderEnabled: true,
      escrow: escrow.port,
    });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'e-side').ctx, stake('back', PRESET_01));
    // Escrow devnet ladder tops out at 0.05 (code 5).
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'e-value').ctx, value('back', 5));

    // No on-chain session is minted at the value tap — the Mini App mints it.
    expect(escrow.calls).toBe(0);
    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(harness.uiState?.get(MARKET_ID)).toEqual({ kind: 'sign', side: 'back', amountCode: 5 });
    // The surface shows a Mini App URL button carrying the amount code, + Back.
    const edit = harness.cardSurfaces.at(-1);
    const buttons = (edit?.keyboard?.inline_keyboard ?? []).flat();
    const first = buttons[0];
    const firstUrl = first !== undefined && 'url' in first ? first.url : undefined;
    expect(firstUrl).toContain('startapp=p-a1111111111141118111111111111111-b-5');
    expect(first?.text).toContain('Review & sign 0.05 SOL');
    expect(buttons.at(-1)?.text).toBe('← Back');
  });

  it('escrow: an over-cap ladder code is refused with no state change', async () => {
    const escrow = recordingEscrowPort();
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      custodyMode: 'escrow',
      refreshableCard: true,
      ladderEnabled: true,
      escrow: escrow.port,
    });
    // 0.1 SOL (code 10) exceeds the escrow devnet 0.05 cap.
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'cap-value').ctx, value('back', 10));
    expect(escrow.calls).toBe(0);
    expect(harness.uiState?.get(MARKET_ID)).toBeNull();
    expect(harness.wagerDb.positions).toHaveLength(0);
  });

  it('the value/back callbacks round-trip through the codec', () => {
    expect(decodeCallback(`sv:${MARKET_ID}:b:5`)).toEqual({
      t: 'stake_value', marketId: MARKET_ID, side: 'back', amountCode: 5,
    });
    expect(decodeCallback(`sb:${MARKET_ID}`)).toEqual({ t: 'stake_back', marketId: MARKET_ID });
  });
});
