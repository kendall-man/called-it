import type { FakeWagerDb } from './fakes.js';
import type { StarterOnlyWagerDb } from './port.js';

export function starterOnlyWagerDbFromFake(db: FakeWagerDb): StarterOnlyWagerDb {
  return {
    getMarketProbability: (marketId) => db.getMarketProbability(marketId),
    getSettlementOutcome: (marketId) => db.getSettlementOutcome(marketId),
    getWagerStatus: () => db.getWagerStatus(),
    hasSettlementApplied: (marketId) => db.hasSettlementApplied(marketId),
    insertSettlementApplied: (marketId) => db.insertSettlementApplied(marketId),
    positionsForMarket: (marketId) => db.positionsForMarket(marketId),
    postWagerLedger: (entry) => db.postWagerLedger(entry),
    setPositionStates: (ids, state) => db.setPositionStates(ids, state),
    settledSolMarketsMissingApplied: () => db.settledSolMarketsMissingApplied(),
    getUserName: (userId) => db.getUserName(userId),
    wagerStarterStake: (args) => db.wagerStake({ ...args, starterOnly: true }),
  };
}
