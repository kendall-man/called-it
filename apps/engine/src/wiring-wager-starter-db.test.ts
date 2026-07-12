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
    const noForbiddenCapabilities: [ForbiddenStarterCapability] extends [never]
      ? true
      : false = true;

    // When the engine adapter is constructed
    const adapter = await buildStarterOnlyWagerDb({
      packageDb: starterOnlyWagerDbFromFake(db),
      engineDb: new TelegramFlowDb(() => 0),
    });

    // Then its type and runtime surface exclude funded authority
    expect(noForbiddenCapabilities).toBe(true);
    expect(Object.keys(adapter).sort()).toEqual([
      'getMarketProbability',
      'getSettlementOutcome',
      'getUserName',
      'getWagerStatus',
      'hasSettlementApplied',
      'insertSettlementApplied',
      'positionsForMarket',
      'postWagerLedger',
      'setPositionStates',
      'settledSolMarketsMissingApplied',
      'wagerStarterStake',
    ]);
  });
});
