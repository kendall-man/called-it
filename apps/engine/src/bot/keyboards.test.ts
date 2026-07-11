import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../ports.js';
import { decodeCallback } from './callbackData.js';
import { offerKeyboard } from './keyboards.js';

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
};

function labels(keyboard: ReturnType<typeof offerKeyboard>): string[][] {
  return keyboard.inline_keyboard.map((row) => row.map((button) => button.text));
}

describe('offer keyboard', () => {
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
});
