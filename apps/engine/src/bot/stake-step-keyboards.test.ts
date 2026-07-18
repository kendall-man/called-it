import { describe, expect, it } from 'vitest';
import { InlineKeyboard } from 'grammy';
import { decodeCallback, type CallbackAction } from './callbackData.js';
import { stakeStepperKeyboard, type StakeStepperKeyboardInput } from './stake-step-keyboards.js';

const MARKET = '0f14d0ab-9605-4a62-a9e4-5ed26688389b';

type Btn = { text: string; callback_data?: string; url?: string };
function rows(keyboard: InlineKeyboard): Btn[][] {
  return keyboard.inline_keyboard.map((row) => row.map((button) => ({ ...button })));
}
function flat(keyboard: InlineKeyboard): Btn[] {
  return rows(keyboard).flat();
}

function stepper(overrides: Partial<StakeStepperKeyboardInput> = {}): InlineKeyboard {
  return stakeStepperKeyboard({
    marketId: MARKET,
    side: 'back',
    code: 1,
    asset: 'sol',
    custody: 'legacy',
    network: 'devnet',
    sideLabel: 'Brazil win it',
    signUrl: null,
    ...overrides,
  });
}

describe('stake stepper keyboard', () => {
  it('at the base rung omits −: [amount 0.01] [+], then a confirm and back row', () => {
    const layout = rows(stepper({ custody: 'legacy', code: 1 }));
    expect(layout[0]?.map((b) => b.text)).toEqual(['0.01 SOL', '+']);
    // The amount button is an idempotent step to its own rung.
    expect(decodeCallback(layout[0]?.[0]?.callback_data ?? '')).toEqual<CallbackAction>({
      t: 'stake_step', marketId: MARKET, side: 'back', amountCode: 1,
    });
    // + steps to the next rung (0.02, code 2).
    expect(decodeCallback(layout[0]?.[1]?.callback_data ?? '')).toEqual<CallbackAction>({
      t: 'stake_step', marketId: MARKET, side: 'back', amountCode: 2,
    });
    expect(layout[1]?.map((b) => b.text)).toEqual(['Confirm 0.01 SOL']);
    expect(layout[2]?.map((b) => b.text)).toEqual(['← Back']);
  });

  it('mid-ladder shows [−] amount [+] with neighbour rung codes', () => {
    const amountRow = rows(stepper({ custody: 'legacy', code: 2 }))[0] ?? [];
    expect(amountRow.map((b) => b.text)).toEqual(['−', '0.02 SOL', '+']);
    expect(decodeCallback(amountRow[0]?.callback_data ?? '')).toMatchObject({ t: 'stake_step', amountCode: 1 });
    expect(decodeCallback(amountRow[1]?.callback_data ?? '')).toMatchObject({ t: 'stake_step', amountCode: 2 });
    expect(decodeCallback(amountRow[2]?.callback_data ?? '')).toMatchObject({ t: 'stake_step', amountCode: 5 });
  });

  it('escrow devnet caps at 0.05: the top rung omits + and shows the sign URL', () => {
    const url = 'https://t.me/callit_testing_bot/app?startapp=p-0f14d0ab96054a62a9e45ed26688389b-b-5';
    const layout = rows(stepper({ custody: 'escrow', network: 'devnet', code: 5, signUrl: url }));
    // At the escrow cap (0.05) there is no + rung.
    expect(layout[0]?.map((b) => b.text)).toEqual(['−', '0.05 SOL']);
    // The action row is the Mini App URL button, carrying the current amount.
    expect(layout[1]?.[0]?.text).toBe('Review & sign 0.05 SOL for Brazil win it');
    expect(layout[1]?.[0]?.url).toBe(url);
    expect(layout[1]?.[0]?.callback_data).toBeUndefined();
    expect(layout[2]?.map((b) => b.text)).toEqual(['← Back']);
  });

  it('legacy custody reaches the 0.1 rung (code 10) with no + at the cap', () => {
    const layout = rows(stepper({ custody: 'legacy', code: 10 }));
    expect(layout[0]?.map((b) => b.text)).toEqual(['−', '0.1 SOL']);
    expect(decodeCallback(layout[0]?.[0]?.callback_data ?? '')).toMatchObject({ t: 'stake_step', amountCode: 5 });
    // Legacy commits via a Confirm callback at the shown rung.
    expect(decodeCallback(layout[1]?.[0]?.callback_data ?? '')).toEqual<CallbackAction>({
      t: 'stake_value', marketId: MARKET, side: 'back', amountCode: 10,
    });
  });

  it('escrow with no Mini App URL falls back to a signing confirm callback', () => {
    const layout = rows(stepper({ custody: 'escrow', network: 'devnet', code: 2, signUrl: null }));
    const action = layout[1]?.[0];
    expect(action?.text).toBe('Review & sign 0.02 SOL for Brazil win it');
    expect(action?.url).toBeUndefined();
    expect(decodeCallback(action?.callback_data ?? '')).toEqual<CallbackAction>({
      t: 'stake_value', marketId: MARKET, side: 'back', amountCode: 2,
    });
  });

  it('the back button is a lossless stake_back callback (no url)', () => {
    const back = flat(stepper()).at(-1);
    expect(back?.text).toBe('← Back');
    expect(back?.url).toBeUndefined();
    expect(decodeCallback(back?.callback_data ?? '')).toEqual({ t: 'stake_back', marketId: MARKET });
  });
});
