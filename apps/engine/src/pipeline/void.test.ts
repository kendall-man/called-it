import { describe, expect, it } from 'vitest';
import type { LogFields } from '../log.js';
import type { MarketRow } from '../ports.js';
import { voidAbandonedMarket } from './void.js';

const MARKET_ID = '60030000-0000-4000-8000-000000000001';
const GROUP_ID = -1_006_003_001;

const MARKET: MarketRow = {
  id: MARKET_ID,
  claim_id: 'claim-6003',
  group_id: GROUP_ID,
  fixture_id: 6003,
  spec: {
    claimType: 'match_winner',
    fixtureId: 6003,
    entityRef: { kind: 'team', participant: 1, name: 'Alpha FC' },
    comparator: 'gte',
    threshold: 1,
    period: 'FT_90',
    trustTier: 'oracle_resolved',
  },
  status: 'open',
  is_replay: false,
  price_provenance: 'market',
  quote_probability: 0.5,
  quote_multiplier: 2,
  odds_message_id: 'odds-6003',
  odds_ts: 1_783_855_200_000,
  card_tg_message_id: 6_003_002,
  created_at: '2026-07-12T12:00:00.000Z',
  currency: 'rep',
};

describe('void abandoned market logging', () => {
  it('retains the market ID without exposing Telegram group identity', async () => {
    // Given an abandoned market and captured structured logs
    const logs: Array<{ readonly event: string; readonly fields: LogFields | undefined }> = [];
    const deps = {
      db: {
        updateMarketStatus: async () => undefined,
        insertSettlement: async () => undefined,
      },
      wager: null,
      log: {
        info: (event: string, fields?: LogFields) => logs.push({ event, fields }),
      },
    };

    // When the market is voided
    await voidAbandonedMarket(deps, MARKET);

    // Then the event keeps only the safe domain identifier
    expect(logs).toEqual([{
      event: 'market_voided_abandoned',
      fields: { marketId: MARKET_ID },
    }]);
  });
});
