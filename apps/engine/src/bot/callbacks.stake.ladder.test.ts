/**
 * Multi-participant stake stepper (STAKE_LADDER_ENABLED). The SHARED market card
 * ALWAYS keeps its two side buttons for every member; a side tap NEVER morphs it.
 * Instead it sends a PER-USER ephemeral message (visible only to the tapper)
 * carrying the stepper. These tests verify: the shared card is untouched on a
 * side tap, the ephemeral sender is called with receiver_user_id +
 * callback_query_id, ± steps edit the per-user ephemeral in place without moving
 * SOL, the commit stakes the chosen amount and closes the ephemeral, Back closes
 * it, over-cap rungs are refused, per-user state is keyed by (market, user), an
 * ephemeral failure degrades to the single-tap flow without touching the shared
 * card, and — critically — with the flag OFF the single-tap flow is unchanged.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { InlineKeyboard } from 'grammy';
import { dispatchCallback } from './callbacks.js';
import { decodeCallback } from './callbackData.js';
import { configureMiniAppOfferKeyboards } from './keyboards.js';
import { STEPPER_CLOSED_LINE } from './stake-step-cards.js';
import type { EscrowTelegramPort } from './escrow-ux.js';
import {
  CHAT_ID,
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

const USER_B = 8002;

function keyboardRows(keyboard: InlineKeyboard | undefined): string[][] {
  return (keyboard?.inline_keyboard ?? []).map((row) => row.map((button) => button.text));
}
function keyboardLabels(keyboard: InlineKeyboard | undefined): string[] {
  return keyboardRows(keyboard).flat();
}
function signUrlOf(keyboard: InlineKeyboard | undefined): string | undefined {
  const button = (keyboard?.inline_keyboard ?? []).flat().find((b) => 'url' in b && b.url);
  return button !== undefined && 'url' in button ? button.url : undefined;
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

describe('multi-participant stepper — flag off parity', () => {
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
    expect(harness.ephemeral).toBeNull();
  });
});

describe('multi-participant stepper — flag on', () => {
  it('the side tap keeps the shared card and opens a PER-USER ephemeral at 0.01', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    const { ctx, toasts } = stakeCtx(USER_A, 'on-side');
    await dispatchCallback(harness.h, ctx, stake('back', PRESET_01));

    // No position, no ledger movement — the side tap is free.
    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(harness.wagerDb.ledger.filter((e) => e.kind === 'stake' || e.kind === 'starter_grant'))
      .toHaveLength(0);
    // The SHARED card is untouched — it never morphs into the stepper.
    expect(harness.cardSurfaces).toHaveLength(0);
    // A per-user ephemeral was sent with receiver_user_id + the tap's callback id.
    expect(harness.ephemeral?.sends).toHaveLength(1);
    const sent = harness.ephemeral?.sends[0];
    expect(sent?.chatId).toBe(CHAT_ID);
    expect(sent?.receiverUserId).toBe(USER_A);
    expect(sent?.callbackQueryId).toBe('on-side');
    // The ephemeral carries the stepper: [amount 0.01] [+], confirm, back.
    expect(keyboardRows(sent?.keyboard)).toEqual([
      ['0.01 SOL', '+'],
      ['Confirm 0.01 SOL'],
      ['← Back'],
    ]);
    // The small sizing copy rides along.
    expect(sent?.text).toContain('base stake');
    // Per-user ui state is keyed by (market, user) and carries the ephemeral id.
    expect(harness.uiState?.get(MARKET_ID, USER_A)).toEqual({
      kind: 'ladder', side: 'back', code: 1, ephemeralMessageId: sent?.ephemeralMessageId,
    });
    expect(toasts.at(-1)).toBe('Brazil to win, now size it below.');
  });

  it('± steps EDIT the per-user ephemeral in place WITHOUT moving SOL', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 's-side').ctx, stake('back', PRESET_01));
    const ephemeralId = harness.ephemeral?.sends[0]?.ephemeralMessageId;
    // + to 0.02, then + to 0.05 — each edits the SAME ephemeral, not the card.
    await dispatchCallback(harness.h, stakeCtx(USER_A, 's-up1').ctx, step('back', 2));
    expect(harness.uiState?.get(MARKET_ID, USER_A)).toMatchObject({ code: 2, ephemeralMessageId: ephemeralId });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 's-up2').ctx, step('back', 5));
    expect(harness.uiState?.get(MARKET_ID, USER_A)).toMatchObject({ code: 5, ephemeralMessageId: ephemeralId });
    // No position, no shared-card edit across the steps.
    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(harness.cardSurfaces).toHaveLength(0);
    // Two in-place ephemeral edits, the last showing [−] 0.05 [+].
    expect(harness.ephemeral?.edits).toHaveLength(2);
    const lastEdit = harness.ephemeral?.edits.at(-1);
    expect(lastEdit?.ephemeralMessageId).toBe(ephemeralId);
    expect(keyboardRows(lastEdit?.keyboard)).toEqual([
      ['−', '0.05 SOL', '+'],
      ['Confirm 0.05 SOL'],
      ['← Back'],
    ]);
  });

  it('the middle amount tap keeps the ephemeral alive without a redundant edit', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'mid-side').ctx, stake('back', PRESET_01));
    const editsAfterEntry = harness.ephemeral?.edits.length ?? 0;
    const { ctx, toasts } = stakeCtx(USER_A, 'mid-tap');
    await dispatchCallback(harness.h, ctx, step('back', 1));
    expect(harness.ephemeral?.edits.length).toBe(editsAfterEntry); // no new edit
    expect(harness.uiState?.get(MARKET_ID, USER_A)).toMatchObject({ code: 1 });
    expect(toasts.at(-1)).toBe('Sizing 0.01 SOL.');
  });

  it('the confirm commits the CHOSEN amount (legacy) and closes the ephemeral', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'v-side').ctx, stake('back', PRESET_01));
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'v-step').ctx, step('back', 2));
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'v-value').ctx, value('back', 2));

    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(harness.wagerDb.lastStakeArgs).toMatchObject({ lamports: 20_000_000n, side: 'back' });
    // The per-user stepper is cleared and its ephemeral closed.
    expect(harness.uiState?.get(MARKET_ID, USER_A)).toBeNull();
    expect(harness.ephemeral?.edits.at(-1)?.text).toBe(STEPPER_CLOSED_LINE);
    // The SHARED card refreshed its tallies but keeps its two side buttons.
    expect(keyboardLabels(harness.cardSurfaces.at(-1)?.keyboard)).toEqual(['Brazil to win', "Draw or loss"]);
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

  it('Back closes the ephemeral and leaves the shared card untouched', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'b-side').ctx, stake('back', PRESET_01));
    const { ctx, toasts } = stakeCtx(USER_A, 'b-back');
    await dispatchCallback(harness.h, ctx, back());

    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(harness.uiState?.get(MARKET_ID, USER_A)).toBeNull();
    // Ephemeral edited to the one-line close; the shared card never touched.
    expect(harness.ephemeral?.edits.at(-1)?.text).toBe(STEPPER_CLOSED_LINE);
    expect(harness.cardSurfaces).toHaveLength(0);
    expect(toasts.at(-1)).toBe('Back to the call.');
  });

  it('two members size the SAME market independently (per-user state + ephemerals)', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
    });
    // A opens and steps to 0.02; B opens and stays at the anchor.
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'ab-a-side').ctx, stake('back', PRESET_01));
    await dispatchCallback(harness.h, stakeCtx(USER_B, 'ab-b-side').ctx, stake('doubt', PRESET_01));
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'ab-a-up').ctx, step('back', 2));

    // Each member has their own ephemeral and their own rung — no clobber.
    const aState = harness.uiState?.get(MARKET_ID, USER_A);
    const bState = harness.uiState?.get(MARKET_ID, USER_B);
    expect(aState).toMatchObject({ side: 'back', code: 2 });
    expect(bState).toMatchObject({ side: 'doubt', code: 1 });
    expect(aState?.ephemeralMessageId).not.toBe(bState?.ephemeralMessageId);
    // Two distinct sends, each to its own member; the shared card is untouched.
    expect(harness.ephemeral?.sends.map((s) => s.receiverUserId)).toEqual([USER_A, USER_B]);
    expect(harness.cardSurfaces).toHaveLength(0);
  });

  it('escrow: stepping updates the ephemeral sign URL and mints NO session', async () => {
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
    // Entry ephemeral sign URL is the 0.01 anchor.
    expect(signUrlOf(harness.ephemeral?.sends[0]?.keyboard))
      .toContain('startapp=p-a1111111111141118111111111111111-b-1');
    // Step up to the escrow devnet cap (0.05, code 5).
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'e-up1').ctx, step('back', 2));
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'e-up2').ctx, step('back', 5));

    // No on-chain session minted while stepping; the Mini App mints it.
    expect(escrow.calls).toBe(0);
    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(harness.cardSurfaces).toHaveLength(0);
    expect(harness.uiState?.get(MARKET_ID, USER_A)).toMatchObject({ code: 5 });
    const lastEdit = harness.ephemeral?.edits.at(-1);
    // At the cap the amount row omits + (2 buttons), then the sign URL, then Back.
    expect(keyboardRows(lastEdit?.keyboard).map((row) => row.length)).toEqual([2, 1, 1]);
    expect(signUrlOf(lastEdit?.keyboard)).toContain('startapp=p-a1111111111141118111111111111111-b-5');
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
    expect(harness.uiState?.get(MARKET_ID, USER_A)).toMatchObject({ code: 1 });
    expect(harness.ephemeral?.edits).toHaveLength(0);
    expect(harness.wagerDb.positions).toHaveLength(0);
  });

  it('an ephemeral send failure degrades to the single-tap flow, shared card intact', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
      ephemeralSendFails: true,
    });
    const { ctx } = stakeCtx(USER_A, 'fail-side');
    await dispatchCallback(harness.h, ctx, stake('back', PRESET_01));

    // The ephemeral sender was tried; it failed, so the base-stake single-tap ran.
    expect(harness.ephemeral?.sendCalls).toBe(1);
    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(harness.wagerDb.lastStakeArgs).toMatchObject({ lamports: 10_000_000n, side: 'back' });
    // No per-user stepper state was set; the shared card refreshed to the plain
    // two-side offer (never a stepper).
    expect(harness.uiState?.get(MARKET_ID, USER_A)).toBeNull();
    expect(keyboardLabels(harness.cardSurfaces.at(-1)?.keyboard)).toEqual(['Brazil to win', "Draw or loss"]);
  });

  it('an ephemeral EDIT failure re-sends a fresh ephemeral so the stepper never strands', async () => {
    const harness = makeHarness({
      stakeAcceptanceEnabled: true,
      refreshableCard: true,
      ladderEnabled: true,
      ephemeralEditFails: true,
    });
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'edit-side').ctx, stake('back', PRESET_01));
    const firstId = harness.ephemeral?.sends[0]?.ephemeralMessageId;
    await dispatchCallback(harness.h, stakeCtx(USER_A, 'edit-up').ctx, step('back', 2));

    // The edit was attempted and failed, so a fresh ephemeral was sent instead.
    expect(harness.ephemeral?.editCalls).toBe(1);
    expect(harness.ephemeral?.sends).toHaveLength(2);
    const secondId = harness.ephemeral?.sends[1]?.ephemeralMessageId;
    expect(secondId).not.toBe(firstId);
    expect(harness.uiState?.get(MARKET_ID, USER_A)).toMatchObject({ code: 2, ephemeralMessageId: secondId });
    expect(harness.cardSurfaces).toHaveLength(0);
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
