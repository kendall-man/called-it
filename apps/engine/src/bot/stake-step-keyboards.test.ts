import { describe, expect, it } from 'vitest';
import { InlineKeyboard } from 'grammy';
import { decodeCallback, type CallbackAction } from './callbackData.js';
import { stakeLadderKeyboard, stakeSignKeyboard } from './stake-step-keyboards.js';

const MARKET = '0f14d0ab-9605-4a62-a9e4-5ed26688389b';

type Btn = { text: string; callback_data?: string; url?: string };
function flat(keyboard: InlineKeyboard): Btn[] {
  return keyboard.inline_keyboard.flatMap((row) => row.map((button) => ({ ...button })));
}

describe('stake ladder keyboard', () => {
  it('escrow devnet shows three ascending rungs plus a back button', () => {
    const kb = stakeLadderKeyboard(MARKET, 'back', 'sol', 'escrow', 'devnet');
    const btns = flat(kb);
    expect(btns.map((b) => b.text)).toEqual(['0.01 SOL', '0.02 SOL', '0.05 SOL', '← Back']);
    const decoded = btns.slice(0, 3).map((b) => decodeCallback(b.callback_data ?? ''));
    expect(decoded).toEqual<CallbackAction[]>([
      { t: 'stake_value', marketId: MARKET, side: 'back', amountCode: 1 },
      { t: 'stake_value', marketId: MARKET, side: 'back', amountCode: 2 },
      { t: 'stake_value', marketId: MARKET, side: 'back', amountCode: 5 },
    ]);
    // 0.01 is leftmost (the anchor by position) — it is a plain rung, not a default.
    expect(btns[0]?.text).toBe('0.01 SOL');
  });

  it('legacy custody adds the 0.1 rung (four rungs)', () => {
    const btns = flat(stakeLadderKeyboard(MARKET, 'doubt', 'sol', 'legacy', 'devnet'));
    expect(btns.map((b) => b.text)).toEqual([
      '0.01 SOL', '0.02 SOL', '0.05 SOL', '0.1 SOL', '← Back',
    ]);
    expect(decodeCallback(btns[3]?.callback_data ?? '')).toEqual({
      t: 'stake_value', marketId: MARKET, side: 'doubt', amountCode: 10,
    });
  });

  it('the back button is a lossless stake_back callback (no url)', () => {
    const back = flat(stakeLadderKeyboard(MARKET, 'back', 'sol', 'escrow', 'devnet')).at(-1);
    expect(back?.text).toBe('← Back');
    expect(back?.url).toBeUndefined();
    expect(decodeCallback(back?.callback_data ?? '')).toEqual({ t: 'stake_back', marketId: MARKET });
  });

  it('sign keyboard is a URL button plus a back-to-ladder button', () => {
    const url = 'https://t.me/callit_testing_bot/app?startapp=p-0f14d0ab96054a62a9e45ed26688389b-b-5';
    const btns = flat(stakeSignKeyboard(MARKET, url, 50_000_000n, 'sol', 'Brazil win it'));
    expect(btns[0]?.text).toBe('Review & sign 0.05 SOL for Brazil win it');
    expect(btns[0]?.url).toBe(url);
    expect(btns[0]?.callback_data).toBeUndefined();
    expect(btns[1]?.text).toBe('← Back');
    expect(decodeCallback(btns[1]?.callback_data ?? '')).toEqual({ t: 'stake_back', marketId: MARKET });
  });
});
