import { describe, expect, it } from 'vitest';
import { TelegramFlowDb } from './points/telegram-points-flow-db.test-support.js';
import { makeFakeDeps } from './wager/fakes.js';
import { starterOnlyWagerDbFromFake } from './wager/starter-fake.test-support.js';
import {
  buildStarterOnlyWagerDb,
  type StarterOnlyWagerDbOptions,
} from './wiring-wager-starter-db.js';

type ForbiddenStarterCapability = Extract<
  keyof StarterOnlyWagerDbOptions,
  | 'chainRuntime'
  | 'createConnection'
  | 'createDb'
  | 'loadTreasury'
  | 'poster'
  | 'treasury'
>;

describe('starter-only wager DB wiring', () => {
  it('accepts only starter and settlement database capabilities', async () => {
    // Given the package starter facade and the engine settlement projection
    const { db } = makeFakeDeps();
    const bulkRequests: number[][] = [];
    const engineDb = Object.assign(new TelegramFlowDb(() => 0), {
      getUserNames: async (userIds: readonly number[]) => {
        bulkRequests.push([...userIds]);
        return new Map(userIds.map((userId) => [userId, `User ${userId}`]));
      },
    });
    const noForbiddenCapabilities: [ForbiddenStarterCapability] extends [never]
      ? true
      : false = true;

    // When the engine adapter is constructed
    const adapter = await buildStarterOnlyWagerDb({
      packageDb: starterOnlyWagerDbFromFake(db),
      engineDb,
    });
    const names = await adapter.getUserNames([2, 1]);

    // Then its type and runtime surface exclude funded authority
    expect(noForbiddenCapabilities).toBe(true);
    expect(Object.keys(adapter).sort()).toEqual([
      'getMarketAsset',
      'getMarketProbability',
      'getSettlementOutcome',
      'getUserNames',
      'getWagerStatus',
      'hasSettlementApplied',
      'insertSettlementApplied',
      'positionsForMarket',
      'postWagerLedger',
      'setPositionStates',
      'settledSolMarketsMissingApplied',
      'settledWagerMarketsMissingApplied',
      'wagerStarterStake',
    ]);
    expect(bulkRequests).toEqual([[2, 1]]);
    expect(names).toEqual(new Map([[2, 'User 2'], [1, 'User 1']]));
  });
});
