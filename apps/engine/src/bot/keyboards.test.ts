import { afterEach, describe, expect, it } from 'vitest';
import type { Deps, MarketRow } from '../ports.js';
import { decodeCallback } from './callbackData.js';
import {
  configureMiniAppOfferKeyboards,
  marketStakeKeyboard,
  miniAppStartParam,
  offerKeyboard,
} from './keyboards.js';

const MARKET: MarketRow = {
  id: '0f14d0ab-9605-4a62-a9e4-5ed26688389b',
  claim_id: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
  group_id: -1001,
  fixture_id: 1,
  spec: {
    claimType: 'match_winner',
    fixtureId: 1,
    entityRef: { kind: 'team', participant: 1, name: 'Brazil' },
    comparator: 'gte',
    threshold: 1,
    period: 'FT_90',
    trustTier: 'oracle_resolved',
  },
  status: 'open',
  is_replay: false,
  price_provenance: 'market',
  quote_probability: 0.6,
  quote_multiplier: 1.6,
  odds_message_id: 'odds-1',
  odds_ts: 0,
  card_tg_message_id: 99,
  created_at: '2026-07-11T00:00:00.000Z',
  currency: 'sol',
  custody_mode: 'legacy',
};

function labels(keyboard: ReturnType<typeof offerKeyboard>): string[][] {
  return keyboard.inline_keyboard.map((row) => row.map((button) => button.text));
}

const OFFER_LABELS = [['It happens · 0.01 SOL'], ['It does not · 0.01 SOL']];

type OfferButton = { text: string; callback_data?: string; url?: string };

function buttons(keyboard: ReturnType<typeof offerKeyboard>): OfferButton[] {
  return keyboard.inline_keyboard.flatMap((row) => row.map((button) => ({ ...button })));
}

function expectCallbackButtons(keyboard: ReturnType<typeof offerKeyboard>): void {
  expect(labels(keyboard)).toEqual(OFFER_LABELS);
  const [back, doubt] = buttons(keyboard);
  expect(decodeCallback(back?.callback_data ?? '')).toEqual({
    t: 'stake', marketId: MARKET.id, side: 'back', presetIndex: 0,
  });
  expect(decodeCallback(doubt?.callback_data ?? '')).toEqual({
    t: 'stake', marketId: MARKET.id, side: 'doubt', presetIndex: 0,
  });
  expect(back?.url).toBeUndefined();
  expect(doubt?.url).toBeUndefined();
}

function configureMiniApp(overrides: {
  custodyMode?: 'legacy' | 'escrow';
  miniAppShortName?: string | undefined;
  botUsername?: () => string | undefined;
} = {}): void {
  configureMiniAppOfferKeyboards({
    custodyMode: overrides.custodyMode ?? 'escrow',
    miniAppShortName: 'miniAppShortName' in overrides ? overrides.miniAppShortName : 'app',
    botUsername: overrides.botUsername ?? (() => 'callit_testing_bot'),
  });
}

describe('offer keyboard', () => {
  afterEach(() => configureMiniAppOfferKeyboards(null));

  it('renders only the two exact 0.01 SOL actions', () => {
    const keyboard = offerKeyboard(MARKET);

    expect(labels(keyboard)).toMatchInlineSnapshot(`
      [
        [
          "It happens · 0.01 SOL",
        ],
        [
          "It does not · 0.01 SOL",
        ],
      ]
    `);
  });

  it('keeps callback buttons when unconfigured', () => {
    expectCallbackButtons(offerKeyboard(MARKET));
  });

  it('renders direct-link Mini App URL buttons with unchanged labels when the flag is active', () => {
    configureMiniApp();

    const keyboard = offerKeyboard(MARKET);

    expect(labels(keyboard)).toEqual(OFFER_LABELS);
    const [back, doubt] = buttons(keyboard);
    expect(back?.url).toBe(
      'https://t.me/callit_testing_bot/app?startapp=p-0f14d0ab96054a62a9e45ed26688389b-b',
    );
    expect(doubt?.url).toBe(
      'https://t.me/callit_testing_bot/app?startapp=p-0f14d0ab96054a62a9e45ed26688389b-d',
    );
    expect(back?.callback_data).toBeUndefined();
    expect(doubt?.callback_data).toBeUndefined();
  });

  it('keeps callback buttons under legacy custody even with the flag configured', () => {
    configureMiniApp({ custodyMode: 'legacy' });
    expectCallbackButtons(offerKeyboard(MARKET));
  });

  it('keeps callback buttons when no short name is configured', () => {
    configureMiniApp({ miniAppShortName: undefined });
    expectCallbackButtons(offerKeyboard(MARKET));
  });

  it('keeps callback buttons until the runtime bot username is known', () => {
    configureMiniApp({ botUsername: () => undefined });
    expectCallbackButtons(offerKeyboard(MARKET));
  });

  it('keeps callback buttons for a market id that does not encode to 32 hex chars', () => {
    configureMiniApp();
    const keyboard = offerKeyboard({ ...MARKET, id: 'not-a-uuid' });
    const [back, doubt] = buttons(keyboard);
    expect(back?.url).toBeUndefined();
    expect(doubt?.url).toBeUndefined();
    expect(labels(keyboard)).toEqual(OFFER_LABELS);
  });

  it('routes card refreshes through the same flag switch', () => {
    configureMiniApp();
    const keyboard = marketStakeKeyboard({} as Deps, MARKET);
    const [back] = buttons(keyboard);
    expect(back?.url).toBe(
      'https://t.me/callit_testing_bot/app?startapp=p-0f14d0ab96054a62a9e45ed26688389b-b',
    );
  });
});

describe('miniAppStartParam', () => {
  it('encodes the shared p-<hex32>-<side letter> contract within Telegram limits', () => {
    const back = miniAppStartParam(MARKET.id, 'back');
    const doubt = miniAppStartParam(MARKET.id, 'doubt');
    expect(back).toBe('p-0f14d0ab96054a62a9e45ed26688389b-b');
    expect(doubt).toBe('p-0f14d0ab96054a62a9e45ed26688389b-d');
    for (const param of [back, doubt]) {
      expect(param).not.toBeNull();
      expect(param?.length).toBeLessThanOrEqual(64);
      expect(param).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('lowercases uppercase market ids so the param stays canonical', () => {
    expect(miniAppStartParam(MARKET.id.toUpperCase(), 'back'))
      .toBe('p-0f14d0ab96054a62a9e45ed26688389b-b');
  });

  it('rejects ids that are not 32 hex chars after removing dashes', () => {
    expect(miniAppStartParam('not-a-uuid', 'back')).toBeNull();
    expect(miniAppStartParam('', 'doubt')).toBeNull();
    expect(miniAppStartParam(`${MARKET.id}00`, 'back')).toBeNull();
  });
});
