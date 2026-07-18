/**
 * N-step stepper (STAKE_LADDER_ENABLED). Verifies the side tap moves no SOL and
 * opens the stepper at the 0.01 anchor, that ± steps re-size without moving SOL,
 * that the explicit confirm commits (legacy) or the escrow sign URL carries the
 * shown amount, that Back is lossless, over-cap rungs are refused, and —
 * critically — that with the flag OFF the single-tap flow is unchanged.
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
  stakeStepAction as step,
  stakeValueAction as value,
} from './callbacks.stake.test-support.js';

function keyboardRows(keyboard: InlineKeyboard | undefined): string[][] {
  return (keyboard?.inline_keyboard ?? []).map((row) => row.map((button) => button.text));
}
function keyboardLabels(keyboard: InlineKeyboard | undefined): string[] {
  return keyboardRows(keyboard).flat();
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

describe('n-step stepper — flag off parity', () => {
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

describe('n-step stepper — flag on', () => {
  it('the side tap moves ZERO SOL: opens the stepper at the 0.01 anchor', async () => {
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
    // The card evolved into the stepper, urgently, on the same message, at 0.01.
    expect(harness.uiState?.get(MARKET_ID)).toEqual({ kind: 'ladder', side: 'back', code: 1 });
    const edit = harness.cardSurfaces.at(-1);
    expect(edit?.messageId).toBe(900);
    expect(edit?.urgent).toBe(true);
    // Amount row omits − at the base rung; action confirms; back is last.
    expect(keyboardRows(edit?.keyboard)).toEqual([
      ['0.01 SOL', '+'],
      ['Confirm 0.01 SOL'],
      ['← Back'],
    ]);
    // The toast names the side, no amount.
    expect(toasts.at(-1)).toBe('Brazil win it — now size it below.');
  });

  it('± steps re-size the card WITHOUT moving SOL', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 's-side').ctx, stake('back', PRESET_01));
    // + to 0.02, then + to 0.05 — codes carried by the buttons.
    await dispatchCallback(harness.h, stakeCtx(USER_A, 's-up1').ctx, step('back', 2));
    expect(harness.uiState?.get(MARKET_ID)).toEqual({ kind: 'ladder', side: 'back', code: 2 });
    const { toasts } = stakeCtx(USER_A, 's-up2');
    await dispatchCallback(harness.h, stakeCtx(USER_A, 's-up2b').ctx, step('back', 5));
    expect(harness.uiState?.get(MARKET_ID)).toEqual({ kind: 'ladder', side: 'back', code: 5 });
    // Not a single position, no ledger movement across the steps.
    expect(harness.wagerDb.positions).toHaveLength(0);
    // Mid-ladder shows [−] amount [+]; at 0.05 (below the legacy cap) + remains.
    expect(keyboardRows(harness.cardSurfaces.at(-1)?.keyboard)).toEqual([
      ['−', '0.05 SOL', '+'],
      ['Confirm 0.05 SOL'],
      ['← Back'],
    ]);
    void toasts;
  });

  it('the middle amount tap keeps the surface alive without a redundant edit', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'mid-side').ctx, stake('back', PRESET_01));
    const editsAfterEntry = harness.cardSurfaces.length;
    const { ctx, toasts } = stakeCtx(USER_A, 'mid-tap');
    // Tap the amount (idempotent step to the current rung).
    await dispatchCallback(harness.h, ctx, step('back', 1));
    expect(harness.cardSurfaces.length).toBe(editsAfterEntry); // no new edit
    expect(harness.uiState?.get(MARKET_ID)).toEqual({ kind: 'ladder', side: 'back', code: 1 });
    expect(toasts.at(-1)).toBe('Sizing 0.01 SOL.');
  });

  it('the confirm commits the CHOSEN amount (legacy) and clears the stepper', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    // Open the stepper (side tap), step to 0.02, then confirm.
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'v-side').ctx, stake('back', PRESET_01));
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'v-step').ctx, step('back', 2));
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'v-value').ctx, value('back', 2));

    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(harness.wagerDb.lastStakeArgs).toMatchObject({ lamports: 20_000_000n, side: 'back' });
    // The stepper is cleared; the card returned to the two-side offer.
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

  it('Back losslessly returns to the two-side offer and clears the stepper', async () => {
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

  it('escrow: stepping updates the in-card sign URL and mints NO session', async () => {
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
    // Entry sign URL is the 0.01 anchor.
    const entryButtons = (harness.cardSurfaces.at(-1)?.keyboard?.inline_keyboard ?? []).flat();
    const entrySign = entryButtons.find((b) => 'url' in b);
    const entryUrl = entrySign !== undefined && 'url' in entrySign ? entrySign.url : undefined;
    expect(entryUrl).toContain('startapp=p-a1111111111141118111111111111111-b-1');
    // Step up to the escrow devnet cap (0.05, code 5).
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'e-up1').ctx, step('back', 2));
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'e-up2').ctx, step('back', 5));

    // No on-chain session is minted while stepping — the Mini App mints it.
    expect(escrow.calls).toBe(0);
    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(harness.uiState?.get(MARKET_ID)).toEqual({ kind: 'ladder', side: 'back', code: 5 });
    // The surface shows the Mini App URL button carrying 0.05, no + (at the cap), + Back.
    const edit = harness.cardSurfaces.at(-1);
    expect(keyboardRows(edit?.keyboard).map((row) => row.length)).toEqual([2, 1, 1]);
    const buttons = (edit?.keyboard?.inline_keyboard ?? []).flat();
    const signButton = buttons.find((b) => 'url' in b && b.url);
    const signUrl = signButton !== undefined && 'url' in signButton ? signButton.url : undefined;
    expect(signUrl).toContain('startapp=p-a1111111111141118111111111111111-b-5');
    expect(signButton?.text).toContain('Review & sign 0.05 SOL');
    expect(buttons.at(-1)?.text).toBe('← Back');
  });

  it('escrow: stepping over the 0.05 devnet cap is refused with no state change', async () => {
    const escrow = recordingEscrowPort();
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      custodyMode: 'escrow',
      refreshableCard: true,
      ladderEnabled: true,
      escrow: escrow.port,
    });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'cap-side').ctx, stake('back', PRESET_01));
    // 0.1 SOL (code 10) exceeds the escrow devnet 0.05 cap.
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'cap-step').ctx, step('back', 10));
    expect(escrow.calls).toBe(0);
    // The stepper stays at the anchor; no forged over-cap rung is honored.
    expect(harness.uiState?.get(MARKET_ID)).toEqual({ kind: 'ladder', side: 'back', code: 1 });
    expect(harness.wagerDb.positions).toHaveLength(0);
  });

  it('the step/value/back callbacks round-trip through the codec', () => {
    expect(decodeCallback(`ss:${MARKET_ID}:b:5`)).toEqual({
      t: 'stake_step', marketId: MARKET_ID, side: 'back', amountCode: 5,
    });
    expect(decodeCallback(`sv:${MARKET_ID}:b:5`)).toEqual({
      t: 'stake_value', marketId: MARKET_ID, side: 'back', amountCode: 5,
    });
    expect(decodeCallback(`sb:${MARKET_ID}`)).toEqual({ t: 'stake_back', marketId: MARKET_ID });
  });
});
