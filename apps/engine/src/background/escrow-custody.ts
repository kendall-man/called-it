import type { Deps, EngineDb, MarketRow } from '../ports.js';

export class EscrowCustodyRoutingError extends Error {
  readonly name = 'EscrowCustodyRoutingError';

  constructor(readonly code: 'legacy_ledger_custody_violation') {
    super(`escrow custody routing rejected: ${code}`);
  }
}

export function createCustodyIsolatedBackgroundDb(
  db: EngineDb,
): EngineDb {
  const legacy = (markets: readonly MarketRow[]) => markets.filter((market) => market.custody_mode === 'legacy');
  return new Proxy(db, {
    get(target, property) {
      if (property === 'openMarketsForFixture') {
        return async (fixtureId: number) => legacy(await db.openMarketsForFixture(fixtureId));
      }
      if (property === 'openMarketsForGroup') {
        return async (groupId: number) => legacy(await db.openMarketsForGroup(groupId));
      }
      if (property === 'postLedger') {
        return async (entry: Parameters<EngineDb['postLedger']>[0]) => {
          if (entry.market_id === null) return db.postLedger(entry);
          const market = await db.getMarket(entry.market_id);
          if (market === null || market.custody_mode !== 'legacy') {
            throw new EscrowCustodyRoutingError('legacy_ledger_custody_violation');
          }
          return db.postLedger(entry);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createCustodyIsolatedBackgroundDeps(deps: Deps): Deps {
  return {
    ...deps,
    db: createCustodyIsolatedBackgroundDb(deps.db),
  };
}
