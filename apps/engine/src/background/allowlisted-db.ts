import type { Env } from '../env.js';
import type { Deps, EngineDb, GroupRow, MarketRow, SettlementRow } from '../ports.js';
import { isBetaGroupAllowed } from '../bot/beta-access.js';

export function createAllowlistedBackgroundDb(
  db: EngineDb,
  env: Pick<Env, 'DEPLOYMENT_ENV' | 'BETA_ALLOWED_GROUP_IDS' | 'PUBLIC_BETA_ENABLED'>,
): EngineDb {
  if (env.DEPLOYMENT_ENV === 'development' || env.PUBLIC_BETA_ENABLED) return db;
  const allowedPositionIds = new Set<string>();
  const getMarket = async (marketId: string): Promise<MarketRow | null> => {
    const market = await db.getMarket(marketId);
    return market !== null && isBetaGroupAllowed(env, market.group_id) ? market : null;
  };
  const listGroups = async (): Promise<GroupRow[]> =>
    (await db.listGroups()).filter((group) => isBetaGroupAllowed(env, group.id));
  const openMarketsForFixture = async (fixtureId: number): Promise<MarketRow[]> =>
    (await db.openMarketsForFixture(fixtureId))
      .filter((market) => isBetaGroupAllowed(env, market.group_id));
  const openMarketsForGroup = async (groupId: number): Promise<MarketRow[]> => {
    if (!isBetaGroupAllowed(env, groupId)) return [];
    return (await db.openMarketsForGroup(groupId))
      .filter((market) => isBetaGroupAllowed(env, market.group_id));
  };
  const expireOverdueClaims = (nowIso: string) =>
    db.expireOverdueClaims(nowIso, env.BETA_ALLOWED_GROUP_IDS);
  const updateMarketStatus: EngineDb['updateMarketStatus'] = async (marketId, status) => {
    if (await getMarket(marketId)) await db.updateMarketStatus(marketId, status);
  };
  const insertSettlement: EngineDb['insertSettlement'] = async (input) => {
    if (await getMarket(input.market_id)) await db.insertSettlement(input);
  };
  const markSettlementPosted: EngineDb['markSettlementPosted'] = async (marketId) => {
    if (await getMarket(marketId)) await db.markSettlementPosted(marketId);
  };
  const getGroup: EngineDb['getGroup'] = async (groupId) =>
    isBetaGroupAllowed(env, groupId) ? db.getGroup(groupId) : null;
  const getClaim: EngineDb['getClaim'] = async (claimId) => {
    const claim = await db.getClaim(claimId);
    return claim !== null && isBetaGroupAllowed(env, claim.group_id) ? claim : null;
  };
  const positionsForMarket: EngineDb['positionsForMarket'] = async (marketId) => {
    if (!await getMarket(marketId)) return [];
    const positions = await db.positionsForMarket(marketId);
    for (const position of positions) allowedPositionIds.add(position.id);
    return positions;
  };
  const setPositionStates: EngineDb['setPositionStates'] = async (ids, state) => {
    const allowedIds = ids.filter((id) => allowedPositionIds.has(id));
    if (allowedIds.length > 0) await db.setPositionStates(allowedIds, state);
  };
  const applyGroupPoints: EngineDb['applyGroupPoints'] = async (marketId) =>
    await getMarket(marketId)
      ? db.applyGroupPoints(marketId)
      : { ok: false, code: 'market_not_found' };
  const pointResultsForMarket: EngineDb['pointResultsForMarket'] = async (marketId) =>
    await getMarket(marketId) ? db.pointResultsForMarket(marketId) : [];
  const positionParticipantsForMarket: EngineDb['positionParticipantsForMarket'] =
    async (marketId) => await getMarket(marketId)
      ? db.positionParticipantsForMarket(marketId)
      : [];
  const leaderboard: EngineDb['leaderboard'] = async (groupId, limit) =>
    isBetaGroupAllowed(env, groupId) ? db.leaderboard(groupId, limit) : [];
  const postLedger: EngineDb['postLedger'] = async (entry) =>
    isBetaGroupAllowed(env, entry.group_id)
      ? db.postLedger(entry)
      : { inserted: false };
  const setMarketQuote: EngineDb['setMarketQuote'] = async (marketId, quote) => {
    if (await getMarket(marketId)) await db.setMarketQuote(marketId, quote);
  };
  const setMarketCardMessage: EngineDb['setMarketCardMessage'] = async (marketId, messageId) => {
    if (await getMarket(marketId)) await db.setMarketCardMessage(marketId, messageId);
  };
  const upsertProof: EngineDb['upsertProof'] = async (input) => {
    if (await getMarket(input.market_id)) await db.upsertProof(input);
  };
  const unpostedSettlements = async (): Promise<SettlementRow[]> => {
    const settlements = await db.unpostedSettlements();
    const allowed: SettlementRow[] = [];
    for (const settlement of settlements) {
      if (await getMarket(settlement.market_id)) allowed.push(settlement);
    }
    return allowed;
  };

  return new Proxy(db, {
    get(target, property) {
      switch (property) {
        case 'getMarket':
          return getMarket;
        case 'getGroup':
          return getGroup;
        case 'getClaim':
          return getClaim;
        case 'expireOverdueClaims':
          return expireOverdueClaims;
        case 'listGroups':
          return listGroups;
        case 'openMarketsForFixture':
          return openMarketsForFixture;
        case 'openMarketsForGroup':
          return openMarketsForGroup;
        case 'updateMarketStatus':
          return updateMarketStatus;
        case 'insertSettlement':
          return insertSettlement;
        case 'markSettlementPosted':
          return markSettlementPosted;
        case 'positionsForMarket':
          return positionsForMarket;
        case 'setPositionStates':
          return setPositionStates;
        case 'applyGroupPoints':
          return applyGroupPoints;
        case 'pointResultsForMarket':
          return pointResultsForMarket;
        case 'positionParticipantsForMarket':
          return positionParticipantsForMarket;
        case 'leaderboard':
          return leaderboard;
        case 'postLedger':
          return postLedger;
        case 'setMarketQuote':
          return setMarketQuote;
        case 'setMarketCardMessage':
          return setMarketCardMessage;
        case 'upsertProof':
          return upsertProof;
        case 'unpostedSettlements':
          return unpostedSettlements;
        default: {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      }
    },
  });
}

export function createAllowlistedBackgroundDeps(deps: Deps): Deps {
  return {
    ...deps,
    db: createAllowlistedBackgroundDb(deps.db, deps.env),
  };
}
