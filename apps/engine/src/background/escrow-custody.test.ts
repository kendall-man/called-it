import { describe, expect, it } from 'vitest';
import type { EngineDb, MarketRow } from '../ports.js';
import { createCustodyIsolatedBackgroundDb, EscrowCustodyRoutingError } from './escrow-custody.js';

const market = (
  id: string,
  groupId: number,
  custodyMode: 'legacy' | 'escrow',
): MarketRow => ({ id, group_id: groupId, custody_mode: custodyMode } as MarketRow);

describe('escrow background custody isolation', () => {
  it('keeps a legacy market in an escrow-enabled group on the legacy settlement route', async () => {
    const markets = [
      market('legacy-same-group', -100_2, 'legacy'),
      market('escrow-same-group', -100_2, 'escrow'),
    ];
    const ledgerMarketIds: Array<string | null> = [];
    const db = {
      async openMarketsForFixture() { return markets; },
      async openMarketsForGroup() { return markets; },
      async getMarket(id: string) { return markets.find((value) => value.id === id) ?? null; },
      async postLedger(entry: { market_id: string | null }) {
        ledgerMarketIds.push(entry.market_id);
        return { inserted: true };
      },
    } as unknown as EngineDb;
    const isolated = createCustodyIsolatedBackgroundDb(db);

    await expect(isolated.openMarketsForFixture(7)).resolves.toEqual([markets[0]]);
    await expect(isolated.openMarketsForGroup(-100_2)).resolves.toEqual([markets[0]]);
    await expect(isolated.postLedger({
      group_id: -100_2, user_id: 1, market_id: 'legacy-same-group',
      kind: 'payout', amount: 10, idempotency_key: 'legacy-payout',
    })).resolves.toEqual({ inserted: true });
    await expect(isolated.postLedger({
      group_id: -100_2, user_id: 1, market_id: 'escrow-same-group',
      kind: 'payout', amount: 10, idempotency_key: 'escrow-payout',
    })).rejects.toBeInstanceOf(EscrowCustodyRoutingError);
    await expect(isolated.postLedger({
      group_id: -100_2, user_id: 1, market_id: null,
      kind: 'topup', amount: 10, idempotency_key: 'balance-recovery',
    })).resolves.toEqual({ inserted: true });
    expect(ledgerMarketIds).toEqual(['legacy-same-group', null]);

    await expect(createCustodyIsolatedBackgroundDb(db).openMarketsForFixture(7))
      .resolves.toEqual([markets[0]]);
  });
});
