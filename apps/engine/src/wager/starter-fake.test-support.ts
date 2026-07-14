import type { FakeWagerDb } from './fakes.js';
import type { StarterOnlyWagerDb } from './port.js';

export function starterOnlyWagerDbFromFake(db: FakeWagerDb): StarterOnlyWagerDb {
  return {
    getMarketProbability: (marketId) => db.getMarketProbability(marketId),
    getMarketAsset: (marketId) => db.getMarketAsset(marketId),
    getSettlementOutcome: (marketId) => db.getSettlementOutcome(marketId),
    getWagerStatus: () => db.getWagerStatus(),
    hasSettlementApplied: (marketId) => db.hasSettlementApplied(marketId),
    insertSettlementApplied: (marketId) => db.insertSettlementApplied(marketId),
    positionsForMarket: (marketId) => db.positionsForMarket(marketId),
    postWagerLedger: (entry) => db.postWagerLedger(entry),
    setPositionStates: (ids, state) => db.setPositionStates(ids, state),
    settledSolMarketsMissingApplied: () => db.settledSolMarketsMissingApplied(),
    settledWagerMarketsMissingApplied: () => db.settledWagerMarketsMissingApplied(),
    getUserNames: (userIds) => db.getUserNames(userIds),
    wagerStarterStake: (args) => db.wagerStake({ ...args, starterOnly: true }),
  };
}
