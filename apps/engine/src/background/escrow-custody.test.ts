import { describe, expect, it } from 'vitest';
import type { EngineDb, MarketRow } from '../ports.js';
import { createCustodyIsolatedBackgroundDb } from './escrow-custody.js';

const market = (id: string, groupId: number): MarketRow => ({ id, group_id: groupId } as MarketRow);

describe('escrow background custody isolation', () => {
  it('removes escrow groups from the legacy settlement reader only in escrow mode', async () => {
    const markets = [market('legacy', -100_1), market('escrow', -100_2)];
    const db = {
      async openMarketsForFixture() { return markets; },
      async openMarketsForGroup() { return markets; },
    } as unknown as EngineDb;
    const isolated = createCustodyIsolatedBackgroundDb(db, {
      custodyMode: 'escrow', escrowGroupIds: [-100_2],
    });

    await expect(isolated.openMarketsForFixture(7)).resolves.toEqual([markets[0]]);
    await expect(isolated.openMarketsForGroup(-100_2)).resolves.toEqual([]);
    expect(createCustodyIsolatedBackgroundDb(db, {
      custodyMode: 'legacy', escrowGroupIds: [-100_2],
    })).toBe(db);
  });
});
