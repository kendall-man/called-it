import type { EngineDb } from './ports.js';
import type { StarterOnlyWagerModuleDeps } from './wager/port.js';

type StarterOnlyWagerDb = StarterOnlyWagerModuleDeps['db'];

type StarterOnlyPackageDbBase = Pick<
  StarterOnlyWagerDb,
  | 'getMarketProbability'
  | 'getSettlementOutcome'
  | 'getWagerStatus'
  | 'hasSettlementApplied'
  | 'insertSettlementApplied'
  | 'postWagerLedger'
  | 'settledSolMarketsMissingApplied'
>;

export interface StarterOnlyPackageDb extends StarterOnlyPackageDbBase {
  readonly wagerStarterStake?: StarterOnlyWagerDb['wagerStarterStake'];
}

type StarterSettlementEngineDb = Pick<
  EngineDb,
  'getUser' | 'positionsForMarket' | 'setPositionStates'
>;

export interface StarterOnlyWagerDbOptions {
  readonly packageDb: StarterOnlyPackageDb;
  readonly engineDb: StarterSettlementEngineDb;
}

export function buildStarterOnlyWagerDb(
  options: StarterOnlyWagerDbOptions,
): StarterOnlyWagerDb {
  const { engineDb, packageDb: wagerDb } = options;
  const wagerStarterStake = wagerDb.wagerStarterStake;
  if (wagerStarterStake === undefined) {
    throw new TypeError('starter-only database facade is missing wagerStarterStake');
  }
  return {
    getMarketProbability: (marketId) => wagerDb.getMarketProbability(marketId),
    getSettlementOutcome: (marketId) => wagerDb.getSettlementOutcome(marketId),
    getWagerStatus: () => wagerDb.getWagerStatus(),
    hasSettlementApplied: (marketId) => wagerDb.hasSettlementApplied(marketId),
    async insertSettlementApplied(marketId) {
      await wagerDb.insertSettlementApplied(marketId);
    },
    positionsForMarket: (marketId) => engineDb.positionsForMarket(marketId),
    postWagerLedger: (entry) => wagerDb.postWagerLedger(entry),
    setPositionStates: (ids, state) => engineDb.setPositionStates(ids, state),
    settledSolMarketsMissingApplied: () => wagerDb.settledSolMarketsMissingApplied(),
    getUserName: async (userId) => (await engineDb.getUser(userId))?.display_name ?? null,
    wagerStarterStake: (args) => wagerStarterStake(args),
  };
}
