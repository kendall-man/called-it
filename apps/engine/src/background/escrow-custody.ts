import type { Deps, EngineDb, MarketRow } from '../ports.js';

export function createCustodyIsolatedBackgroundDb(
  db: EngineDb,
  input: {
    readonly custodyMode: 'legacy' | 'escrow';
    readonly escrowGroupIds: readonly number[];
  },
): EngineDb {
  if (input.custodyMode === 'legacy') return db;
  const escrowGroups = new Set(input.escrowGroupIds);
  const legacy = (markets: readonly MarketRow[]) => markets.filter((market) => !escrowGroups.has(market.group_id));
  return new Proxy(db, {
    get(target, property) {
      if (property === 'openMarketsForFixture') {
        return async (fixtureId: number) => legacy(await db.openMarketsForFixture(fixtureId));
      }
      if (property === 'openMarketsForGroup') {
        return async (groupId: number) => escrowGroups.has(groupId)
          ? []
          : legacy(await db.openMarketsForGroup(groupId));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createCustodyIsolatedBackgroundDeps(deps: Deps): Deps {
  return {
    ...deps,
    db: createCustodyIsolatedBackgroundDb(deps.db, {
      custodyMode: deps.env.WAGER_CUSTODY_MODE,
      escrowGroupIds: deps.env.ESCROW_ALLOWED_GROUP_IDS,
    }),
  };
}
